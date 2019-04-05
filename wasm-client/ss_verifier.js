
const toTaskInfo = require('./util/toTaskInfo')
const midpoint = require('./util/midpoint')
const recovery = require('./recovery')
const assert = require('assert')

const fsHelpers = require('./fsHelpers')

const ps = require('./ps')

let verifiers = []

module.exports = {
    get: () => verifiers.filter(a => !a.exited()),
    init: async (os, account, test = false, recover = -1) => {

        let { web3, logger, throttle } = os
        let mcFileSystem = os.fileSystem

        logger.info(`Verifier initialized! ${test ? "(Test mode)" : ""}`)

        let p = await ps.make(web3, logger, recover, account, "VERIFIER")

        verifiers.push(p.ps)

        let [incentiveLayer, fileSystem, disputeResolutionLayer] = await ps.setup(web3)

        let helpers = fsHelpers.init(fileSystem, web3, mcFileSystem, logger, incentiveLayer, account, os.config)

        //INCENTIVE

        //Solution committed event
        p.addEvent("SolutionsCommitted", incentiveLayer.events.SolutionsCommitted, async result => {

            logger.info(`VERIFIER: Solution has been posted`)

            let taskID = result.taskID
            let solverHash0 = result.solutionHash
            let taskInfo = toTaskInfo(await incentiveLayer.methods.getTaskInfo(taskID).call())
            taskInfo.taskID = taskID

            if (Object.keys(p.tasks).length <= throttle) {

                logger.info("VERIFIER: Setting up VM")
                let vm = await helpers.setupVMWithFS(taskInfo)

                logger.info("VERIFIER: Executing task")
                let interpreterArgs = []
                solution = await vm.executeWasmTask(interpreterArgs)

                logger.info(`VERIFIER: Executed task ${taskID}. Checking solutions`)

                p.task_list.push(taskID)

                let myHash = solution.hash
                if (test) myHash = "0x" + helpers.makeSecret(myHash)

                p.tasks[taskID] = {
                    solverHash0: solverHash0,
                    solutionHash: solution.hash,
                    vm: vm,
                }

                if (myHash != solverHash0) {
                    await incentiveLayer.methods.makeChallenge(taskID).send({ from: account, gas: 350000, value: web3.utils.toWei("0.01", "ether") })

                    logger.info(`VERIFIER: Challenged solution for task ${taskID}`)
                }
                else logger.info(`VERIFIER: Solution was correct for task ${taskID}`)


            }
        })

        p.addEvent("VerificationCommitted", incentiveLayer.events.VerificationCommitted, async result => { })

        p.addEvent("TaskFinalized", incentiveLayer.events.TaskFinalized, async (result) => {
            let taskID = result.taskID

            if (p.tasks[taskID]) {
                delete p.tasks[taskID]
                logger.info(`VERIFIER: Task ${taskID} finalized.`)
            }

        })

        p.addEvent("SlashedDeposit", incentiveLayer.events.SlashedDeposit, async (result) => {
            let addr = result.account

            if (account.toLowerCase() == addr.toLowerCase()) {
                logger.info("VERIFIER: Oops, I was slashed, hopefully this was a test")
            }

        })

        // DISPUTE

        p.addEvent("StartChallenge", disputeResolutionLayer.events.StartChallenge, async result => {
            let challenger = result.c

            if (challenger.toLowerCase() == account.toLowerCase()) {
                let gameID = result.gameID

                p.game_list.push(gameID)

                let taskID = await disputeResolutionLayer.methods.getTask(gameID).call()

                p.games[gameID] = {
                    prover: result.prover,
                    taskID: taskID
                }
            }
        })

        p.addEvent("Queried", disputeResolutionLayer.events.Queried, async result => {})

        p.addEvent("Reported", disputeResolutionLayer.events.Reported, async result => {
            let gameID = result.gameID

            if (!p.games[gameID]) return

            let lowStep = parseInt(result.idx1)
            let highStep = parseInt(result.idx2)
            let taskID = p.games[gameID].taskID

            logger.info(`VERIFIER: Report received game: ${gameID} low: ${lowStep} high: ${highStep}`)

            let stepNumber = midpoint(lowStep, highStep)

            let reportedStateHash = result.arr[0]

            let stateHash = await p.tasks[taskID].vm.getLocation(stepNumber, p.tasks[taskID].interpreterArgs)

            let num = reportedStateHash == stateHash ? 1 : 0

            await disputeResolutionLayer.methods.query(gameID, lowStep, highStep, num, result.report_hash).send({ from: account, gas: 100000 })

        })

        p.addEvent("PostedPhases", disputeResolutionLayer.events.PostedPhases, async result => {
            let gameID = result.gameID

            if (!p.games[gameID]) return

            logger.info(`VERIFIER: Phases posted for game: ${gameID}`)

            let lowStep = result.idx1
            let phases = result.arr

            let taskID = p.games[gameID].taskID

            if (test) {
                await disputeResolutionLayer.methods.selectPhase(gameID, lowStep, phases[3], 3).send({ from: account, gas: 100000 })
            } else {

                let states = (await p.tasks[taskID].vm.getStep(lowStep, p.tasks[taskID].interpreterArgs)).states

                for (let i = 0; i < phases.length; i++) {
                    if (states[i] != phases[i]) {
                        await disputeResolutionLayer.methods.selectPhase(gameID, lowStep, phases[i], i).send({ from: account, gas: 100000 })
                        return
                    }
                }
            }

        })

        p.addEvent("WinnerSelected", disputeResolutionLayer.events.WinnerSelected, async (result) => {
            let gameID = result.gameID
            delete p.games[gameID]
        })
        
        async function handleTimeouts(taskID) {

            if (p.busy(taskID)) return

            if (await incentiveLayer.methods.solverLoses(taskID).call({ from: account })) {

                p.working(taskID)
                logger.info(`VERIFIER: Winning verification game for task ${taskID}`)

                await incentiveLayer.methods.solverLoses(taskID).send({ from: account })

            }
            if (await incentiveLayer.methods.isTaskTimeout(taskID).call({ from: account })) {

                p.working(taskID)
                logger.info(`VERIFIER: Timeout in task ${taskID}`)

                await incentiveLayer.methods.taskTimeout(taskID).call({ from: account })

            }
        }

        async function handleGameTimeouts(gameID) {
            // console.log("Verifier game timeout")
            if (p.busy(gameID)) return
            if (await disputeResolutionLayer.methods.gameOver(gameID).call()) {
                p.working(gameID)

                logger.info(`VERIFIER: Triggering game over, game: ${gameID}`)

                await disputeResolutionLayer.methods.gameOver(gameID).send({ from: account })
            }
        }

        async function recoverTask(taskID) {
            let taskInfo = toTaskInfo(await incentiveLayer.methods.getTaskInfo(taskID).call())
            if (!p.tasks[taskID]) p.tasks[taskID] = {}
            p.tasks[taskID].taskInfo = taskInfo
            taskInfo.taskID = taskID

            logger.info(`RECOVERY: Verifying task ${taskID}`)

            let vm = await helpers.setupVMWithFS(taskInfo)

            assert(vm != undefined, "vm is undefined")

            let interpreterArgs = []
            let solution = await vm.executeWasmTask(interpreterArgs)
            p.tasks[taskID].solution = solution
            p.tasks[taskID].vm = vm
        }

        async function recoverGame(gameID) {
            let taskID = await disputeResolutionLayer.methods.getTask(gameID).call()

            if (!p.tasks[taskID]) logger.error(`FAILURE: haven't recovered task ${taskID} for game ${gameID}`)

            logger.info(`RECOVERY: Solution to task ${taskID} has been challenged`)

            p.games[gameID] = {
                taskID: taskID
            }
        }

        p.recover(recoverTask, recoverGame, disputeResolutionLayer, incentiveLayer, true)

        let ival

        let cleanup = () => {
            try {
                let empty = data => { }
                clearInterval(ival)
                // clean_list.forEach(ev => ev.stopWatching(empty))
            }
            catch (e) {
                console.log(e)
                logger.error("VERIFIER: Error when stopped watching events")
            }
            p.exited = true
            logger.info("VERIFIER: Exiting")
        }

        ival = setInterval(() => {
            if (p.exiting && p.task_list.length == 0) return cleanup()
            p.cleanUp()
            p.task_list.forEach(async t => {
                try {
                    await handleTimeouts(t)
                }
                catch (e) {
                    console.log(e)
                    logger.error(`Error while handling timeouts of task ${t}: ${e.toString()}`)
                }
            })
            p.game_list.forEach(async g => {
                try {
                    await handleGameTimeouts(g)
                }
                catch (e) {
                    console.log(e)
                    logger.error(`Error while handling timeouts of game ${g}: ${e.toString()}`)
                }
            })
        }, 2000)

        return cleanup
    }
}
