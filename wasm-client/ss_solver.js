
const toTaskInfo = require('./util/toTaskInfo')
const toSolutionInfo = require('./util/toSolutionInfo')
const midpoint = require('./util/midpoint')
const toIndices = require('./util/toIndices')
const assert = require('assert')
const recovery = require('./recovery')

const fsHelpers = require('./fsHelpers')

const ps = require('./ps')

let solvers = []

module.exports = {
    get: () => solvers.filter(a => !a.exited()),
    init: async (os, account, test = false, recover = -1) => {

        let { web3, logger, throttle } = os
        let mcFileSystem = os.fileSystem

        logger.info(`Solver initialized at block ${await web3.eth.getBlockNumber()}`)

        let p = await ps.make(web3, logger, recover, account, "SOLVER")

        solvers.push(p.ps)

        const merkleComputer = require("./merkle-computer")(logger, '../ocaml-offchain/interpreter/wasm')

        let [incentiveLayer, fileSystem, disputeResolutionLayer] = await ps.setup(web3)

        let helpers = fsHelpers.init(fileSystem, web3, mcFileSystem, logger, incentiveLayer, account, os.config)

        p.addEvent("TaskCreated", incentiveLayer.events.TaskCreated, async (result) => {

            if (p.exiting) return

            let taskID = result.taskID

            logger.info(`SOLVER: Task ${taskID} has been posted. Going to solve it.`)

            let taskInfo = toTaskInfo(await incentiveLayer.methods.getTaskInfo(taskID).call())
            p.addTask(taskID)
            p.tasks[taskID].taskInfo = taskInfo
            taskInfo.taskID = taskID

            logger.info(`SOLVER: Solving task ${taskID}`)

            let vm = await helpers.setupVMWithFS(taskInfo)

            assert(vm != undefined, "vm is undefined")

            let interpreterArgs = []
            let solution = await vm.executeWasmTask(interpreterArgs)
            p.tasks[taskID].solution = solution

            logger.info(`SOLVER: Committing solution ${solution.hash} (hashed ${web3.utils.soliditySha3(solution.hash)})`)

            try {
                await incentiveLayer.methods.commitSolution(taskID, solution.hash).send({ from: account, gas: 1000000 })

                logger.info(`SOLVER: Submitted solution for task ${taskID} successfully`)

                p.tasks[taskID].solution = solution
                p.tasks[taskID].vm = vm
                p.tasks[taskID].interpreterArgs = interpreterArgs

            } catch (e) {
                logger.info(`SOLVER: Unsuccessful submission for task ${taskID}`)
                console.log(e)
            }

        })

        p.addEvent("SolutionsCommitted", incentiveLayer.events.SolutionsCommitted, async result => {
            logger.info("SOLVER: Committed a solution hash")
        })

        p.addEvent("SolutionRevealed", incentiveLayer.events.SolutionRevealed, async result => {
            logger.info("SOLVER: Revealed correct solution")
        })

        p.addEvent("EndRevealPeriod", incentiveLayer.events.EndRevealPeriod, async (result) => {
            let taskID = result.taskID

            if (p.tasks[taskID]) {
                let vm = p.tasks[taskID].solution.vm
                await incentiveLayer.methods.revealSolution(taskID, vm.code, vm.input_size, vm.input_name, vm.input_data).send({ from: account, gas: 1000000 })
                await helpers.uploadOutputs(taskID, p.tasks[taskID].vm)

                logger.info(`SOLVER: Revealed solution for task: ${taskID}. Outputs have been uploaded.`)
            }

        })

        p.addEvent("TaskFinalized", incentiveLayer.events.TaskFinalized, async (result) => {
            let taskID = result.taskID

            if (p.tasks[taskID]) {
                delete p.tasks[taskID]
                logger.info(`SOLVER: Task ${taskID} finalized.`)
            }

        })

        p.addEvent("SlashedDeposit", incentiveLayer.events.SlashedDeposit, async (result) => {
            let addr = result.account

            if (account.toLowerCase() == addr.toLowerCase()) {
                logger.info("SOLVER: Oops, I was slashed, hopefully this was a test")
            }

        })

        // DISPUTE

        p.addEvent("StartChallenge", disputeResolutionLayer.events.StartChallenge, async (result) => {
            let solver = result.p
            let gameID = result.gameID

            if (solver.toLowerCase() == account.toLowerCase()) {

                p.game_list.push(gameID)

                let taskID = await disputeResolutionLayer.methods.getTask(gameID).call()

                logger.info(`SOLVER: Solution to task ${taskID} has been challenged`)

                //Initialize verification game
                let vm = p.tasks[taskID].vm

                // let solution = tasks[taskID].solution

                let initWasm = await vm.initializeWasmTask(p.tasks[taskID].interpreterArgs)
                let solution = await vm.getOutputVM(p.tasks[taskID].interpreterArgs)

                let lowStep = 0
                let highStep = solution.steps + 1

                p.games[gameID] = {
                    lowStep: lowStep,
                    highStep: highStep,
                    taskID: taskID
                }

                await disputeResolutionLayer.methods.initialize(
                    gameID,
                    merkleComputer.getRoots(initWasm.vm),
                    merkleComputer.getPointers(initWasm.vm),
                    solution.steps + 1,
                    merkleComputer.getRoots(solution.vm),
                    merkleComputer.getPointers(solution.vm)).send({from: account, gas: 1000000})

                logger.info(`SOLVER: Game ${gameID} has been initialized`)

                let indices = toIndices(await disputeResolutionLayer.methods.getIndices(gameID).call())

                //Post response to implied midpoint query
                let stepNumber = midpoint(indices.low, indices.high)

                let stateHash = await p.tasks[taskID].vm.getLocation(stepNumber, p.tasks[taskID].interpreterArgs)

                await disputeResolutionLayer.methods.report(gameID, indices.low, indices.high, [stateHash]).send({ from: account, gas:100000 })

                logger.info(`SOLVER: Reported state hash for step: ${stepNumber} game: ${gameID} low: ${indices.low} high: ${indices.high}`)

            }
        })

        p.addEvent("Queried", disputeResolutionLayer.events.Queried, async (result) => {
            let gameID = result.gameID
            let lowStep = parseInt(result.idx1)
            let highStep = parseInt(result.idx2)

            if (p.games[gameID]) {

                let taskID = p.games[gameID].taskID

                logger.info(`SOLVER: Received query Task: ${taskID} Game: ${gameID}`)

                if (lowStep + 1 != highStep) {
                    let stepNumber = midpoint(lowStep, highStep)

                    let stateHash = await p.tasks[taskID].vm.getLocation(stepNumber, p.tasks[taskID].interpreterArgs)

                    await disputeResolutionLayer.methods.report(gameID, lowStep, highStep, [stateHash]).send({ from: account, gas:100000 })

                    logger.info(`SOLVER: Reported state for step ${stepNumber}`)

                } else {
                    //Final step -> post phases

                    // let lowStepState = await disputeResolutionLayer.getStateAt.call(gameID, lowStep)
                    // let highStepState = await disputeResolutionLayer.getStateAt.call(gameID, highStep)

                    let states = (await p.tasks[taskID].vm.getStep(lowStep, p.tasks[taskID].interpreterArgs)).states

                    await disputeResolutionLayer.methods.postPhases(gameID, lowStep, states).send({from: account, gas: 400000})

                    logger.info(`SOLVER: Phases have been posted for game ${gameID}`)

                }

            }
        })

        p.addEvent("SelectedPhase", disputeResolutionLayer.events.SelectedPhase, async (result) => {
            let gameID = result.gameID
            if (p.games[gameID]) {
                let taskID = p.games[gameID].taskID

                let lowStep = parseInt(result.idx1)
                let phase = parseInt(result.phase)

                logger.info(`SOLVER: Phase ${phase} for game ${gameID}`)

                let stepResults = await p.tasks[taskID].vm.getStep(lowStep, p.tasks[taskID].interpreterArgs)

                let phaseStep = merkleComputer.phaseTable[phase]

                let proof = stepResults[phaseStep]

                let merkle = proof.location || []

                let merkle2 = []

                if (proof.merkle) {
                    merkle = proof.merkle.list || proof.merkle.list1 || []
                    merkle2 = proof.merkle.list2 || []
                }

                let m = proof.machine || { reg1: 0, reg2: 0, reg3: 0, ireg: 0, vm: "0x00", op: "0x00" }
                let vm
                if (typeof proof.vm != "object") {
                    vm = {
                        code: "0x00",
                        stack: "0x00",
                        call_stack: "0x00",
                        calltable: "0x00",
                        globals: "0x00",
                        memory: "0x00",
                        calltypes: "0x00",
                        input_size: "0x00",
                        input_name: "0x00",
                        input_data: "0x00",
                        pc: 0,
                        stack_ptr: 0,
                        call_ptr: 0,
                        memsize: 0
                    }
                } else { vm = proof.vm }

                if (phase == 6 && parseInt(m.op.substr(-12, 2), 16) == 16) {
                    disputeResolutionLayer.methods.callCustomJudge(
                        gameID,
                        lowStep,
                        m.op,
                        [m.reg1, m.reg2, m.reg3, m.ireg],
                        proof.merkle.result_state,
                        proof.merkle.result_size,
                        proof.merkle.list,
                        merkleComputer.getRoots(vm),
                        merkleComputer.getPointers(vm)).send({ from: account, gas: 500000 })

                    //TODO
                    //merkleComputer.getLeaf(proof.merkle.list, proof.merkle.location)
                    //merkleComputer.storeHash(hash, proof.merkle.data)
                } else {
                    await disputeResolutionLayer.methods.callJudge(
                        gameID,
                        lowStep,
                        phase,
                        merkle,
                        merkle2,
                        m.vm,
                        m.op,
                        [m.reg1, m.reg2, m.reg3, m.ireg],
                        merkleComputer.getRoots(vm),
                        merkleComputer.getPointers(vm)).send({ from: account, gas: 5000000 })
                }

                logger.info(`SOLVER: Judge called for game ${gameID}`)

            }
        })

        p.addEvent("WinnerSelected", disputeResolutionLayer.events.WinnerSelected, async (result) => {
            let gameID = result.gameID
            delete p.games[gameID]
        })

        p.addEvent("Reported", disputeResolutionLayer.events.Reported, async (result) => {})

        // Timeouts

        async function handleGameTimeouts(gameID) {
            if (p.busy(gameID)) return
            if (await disputeResolutionLayer.methods.gameOver(gameID).call()) {

                p.working(gameID)
                await disputeResolutionLayer.methods.gameOver(gameID).send( { from: account })

                logger.info(`SOLVER: gameOver was called for game ${gameID}`)

            }
        }

        async function handleTimeouts(taskID) {
            // console.log("Handling task", taskID)

            if (p.busy(taskID)) {
                logger.info("SOLVER: Task busy")
                return
            }

            let endReveal = await incentiveLayer.methods.endChallengePeriod(taskID).call()

            if (endReveal) {

                p.working(taskID)
                await incentiveLayer.methods.endChallengePeriod(taskID).send({ from: account, gas: 100000 })

                logger.info(`SOLVER: Ended challenge period for ${taskID}`)

            }

            if (await incentiveLayer.methods.canRunVerificationGame(taskID).call()) {

                p.working(taskID)
                await incentiveLayer.methods.runVerificationGame(taskID).send( { from: account, gas: 1000000 })

                logger.info(`SOLVER: Ran verification game for ${taskID}`)

            }

            if (await incentiveLayer.methods.canFinalizeTask(taskID).call()) {

                // console.log("Tax should be", (await incentiveLayer.getTax.call(taskID)).toString())

                p.working(taskID)
                await incentiveLayer.methods.finalizeTask(taskID).send({ from: account, gas: 1000000 })

                logger.info(`SOLVER: Finalized task ${taskID}`)

            }
        }

        async function recoverTask(taskID) {
            let taskInfo = toTaskInfo(await incentiveLayer.methods.getTaskInfo(taskID).call())

            p.addTask(taskID)

            p.tasks[taskID].taskInfo = taskInfo
            taskInfo.taskID = taskID

            logger.info(`SOLVER RECOVERY: Solving task ${taskID}`)

            let vm = await helpers.setupVMWithFS(taskInfo)

            assert(vm != undefined, "vm is undefined")

            let interpreterArgs = []
            let solution = await vm.executeWasmTask(interpreterArgs)
            p.tasks[taskID].solution = solution
            p.tasks[taskID].vm = vm
        }

        async function recoverGame(gameID) {
            let taskID = await disputeResolutionLayer.methods.getTask(gameID).call()

            if (!p.tasks[taskID]) logger.error(`SOLVER FAILURE: haven't recovered task ${taskID} for game ${gameID}`)

            logger.info(`SOLVER RECOVERY: Solution to task ${taskID} has been challenged`)

            //Initialize verification game
            let solution = p.tasks[taskID].solution

            let lowStep = 0
            let highStep = solution.steps + 1

            p.games[gameID] = {
                lowStep: lowStep,
                highStep: highStep,
                taskID: taskID
            }
        }

        p.recover(recoverTask, recoverGame, disputeResolutionLayer, incentiveLayer, false)

        let ival

        let cleanup = () => {
            try {
                clearInterval(ival)
                let empty = data => { }
                // clean_list.forEach(ev => ev.stopWatching(empty))
            } catch (e) {
                logger.error("SOLVER: Error when stopped watching events")
            }
            p.exited = true
            logger.info("SOLVER: Exiting")
        }

        ival = setInterval(async () => {
            if (p.exiting && p.task_list.length == 0) return cleanup()
            p.cleanUp()
            p.task_list.forEach(async t => {
                try {
                    await handleTimeouts(t)
                }
                catch (e) {
                    // console.log(e)
                    logger.error(`SOLVER: Error while handling timeouts of task ${t}: ${e.toString()}`)
                }
            })
            p.game_list.forEach(async g => {
                try {
                    await handleGameTimeouts(g)
                }
                catch (e) {
                    // console.log(e)
                    logger.error(`SOLVER: Error while handling timeouts of game ${g}: ${e.toString()}`)
                }
            })
        }, 2000)

        return cleanup
    }
}
