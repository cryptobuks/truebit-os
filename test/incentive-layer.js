const assert = require('assert')
const fs = require('fs')
const contractsConfig = require('../wasm-client/util/contractsConfig')
const mineBlocks = require('../os/lib/util/mineBlocks')

function contract(web3, info) {
    return new web3.eth.Contract(info.abi, info.address)    
}

async function setup(web3) {
	const config = await contractsConfig(web3)

	return [
		contract(web3, config['ss_incentiveLayer']),
		contract(web3, config['tru']),
	]
}

describe('Truebit Incentive Layer Smart Contract Unit Tests', function () {
	this.timeout(60000)

	let incentiveLayer, tru, taskGiver, solver, verifier, accounts, dummy
	let minDeposit, taskID, randomBits, randomBitsHash, solution0Hash, solution1Hash, web3

	before(async () => {
		let os = await require('../os/kernel')('./wasm-client/config.json')

		let contracts = await setup(os.web3)

		web3 = os.web3

		incentiveLayer = contracts[0]
		tru = contracts[1]

		taskGiver = os.accounts[1]
		solver = os.accounts[0]
		verifier = os.accounts[2]
		dummy = os.accounts[3]

		accounts = [taskGiver, solver, verifier]

		minDeposit = "1000000000000000000"

		randomBits = 42
		randomBitsHash = os.web3.utils.soliditySha3(randomBits)
		solution0Hash = os.web3.utils.soliditySha3(0x0, 0x0, 0x0, 0x0)
		// solutionCommit = os.web3.utils.soliditySha3(solution0Hash)
		solutionCommit = solution0Hash

		/*
		for (let account of accounts) {
			await tru.approve(incentiveLayer.address, minDeposit, { from: account })
		}
		*/

	})

    after(async () => {
        web3.currentProvider.disconnect()
    })

	it("task giver should create a task", async () => {
		const maxDifficulty = 1

		let tx = await incentiveLayer.methods.createTask("0x0", 0, "0x0", maxDifficulty).send({ from: taskGiver, gas: 300000, value: 123 })

		let log = tx.events['TaskCreated'].returnValues

		//confirm existence of params in event
		assert(log.taskID)
		assert(log.codeType)
		assert(log.bundleId == 0x0)
		assert(log.blockNumber)
		assert(log.reward)

		taskID = log.taskID
	})

	it("should reject creating a task with max difficulty set to zero", async () => {
		return incentiveLayer.methods.createTask("0x0", 0, "0x0", 0).send({ from: taskGiver, gas: 300000, value: 100001 })
			.then(
				() => Promise.reject(new Error('Expected method to reject')),
				err => assert(err instanceof Error)
			)
	})

	it("should reject creating a task with reward set to zero", async () => {
		return incentiveLayer.methods.createTask("0x0", 0, "0x0", 1).send({ from: taskGiver, gas: 300000 })
			.then(
				() => Promise.reject(new Error('Expected method to reject')),
				err => assert(err instanceof Error)
			)
	})

	it("should reject creating a task with improper code type", async () => {
		return incentiveLayer.methods.createTask("0x0", 42, "0x0", 1).send({ from: taskGiver, gas: 300000, value: 100001 })
			.then(
				() => Promise.reject(new Error('Expected method to reject')),
				err => assert(err instanceof Error)
			)
	})

	it("should get vm parameters", async () => {
		let p = await incentiveLayer.methods.getVMParameters(taskID).call()
		let params = {
			stackSize: p[0],
			memorySize: p[1],
			globalsSize: p[2],
			tableSize: p[3],
			callSize: p[4]
		}

		//Testing for default parameters
		assert.equal(params.stackSize, 14)
		assert.equal(params.memorySize, 16)
		assert.equal(params.globalsSize, 8)
		assert.equal(params.tableSize, 8)
		assert.equal(params.callSize, 10)
	})

	it("should get task info", async () => {
		let t = await incentiveLayer.methods.getTaskInfo(taskID).call()

		let taskInfo = {
			taskGiver: t[0],
			taskInitHash: t[1],
			codeType: t[2],
			bundleId: t[3],
			taskID: t[4]
		}

		assert.equal(taskInfo.taskGiver.toLowerCase(), taskGiver.toLowerCase())
		assert.equal(taskInfo.taskInitHash, 0x0)
		assert.equal(taskInfo.codeType, 0)
		assert.equal(taskInfo.bundleId, 0x0)
		assert.equal(taskInfo.taskID, taskID)
	})

	it("should reject committing solution from others", async () => {
		return incentiveLayer.methods.commitSolution(taskID, solutionCommit).send({ from: verifier, gas: 300000 })
			.then(
				() => Promise.reject(new Error('Expected method to reject')),
				err => assert(err instanceof Error)
			)
	})

	it("solver should commit a solution", async () => {
		let tx = await incentiveLayer.methods.commitSolution(taskID, solutionCommit).send({ from: solver, gas: 300000 })

		let log = tx.events['SolutionsCommitted'].returnValues

		assert(log.taskID)
		assert(log.bundleId == 0x0)
		assert(log.codeType)
	})

	it("should reject committing solution again", async () => {
		return incentiveLayer.methods.commitSolution(taskID, solutionCommit).send({ from: solver, gas: 300000 })
			.then(
				() => Promise.reject(new Error('Expected method to reject')),
				err => assert(err instanceof Error)
			)
	})

	it("should end challenge period", async () => {
		assert(!(await incentiveLayer.methods.endChallengePeriod(taskID).call()))

		await mineBlocks(web3, 20)

		assert(await incentiveLayer.methods.endChallengePeriod(taskID).call())
		await incentiveLayer.methods.endChallengePeriod(taskID).send({ from: solver, gas: 100000 })
	})

	it("should reject revealing solution if not selected solver", async () => {
		return incentiveLayer.methods.revealSolution(taskID, "0x0", "0x0", "0x0", "0x0").send({ from: verifier, gas: 300000 })
			.then(
				() => Promise.reject(new Error('Expected method to reject')),
				err => assert(err instanceof Error)
			)
	})

	it("should reveal solution", async () => {
		let tx = await incentiveLayer.methods.revealSolution(taskID, "0x0", "0x0", "0x0", "0x0").send({ from: solver, gas: 300000 })

		let log = tx.events['SolutionRevealed'].returnValues

		assert(log.taskID)
	})

	it("should fail revealing solution another time", async () => {
		return incentiveLayer.methods.revealSolution(taskID, "0x0", "0x0", "0x0", "0x0").send({ from: solver, gas: 300000 })
			.then(
				() => Promise.reject(new Error('Expected method to reject')),
				err => assert(err instanceof Error)
			)
	})

	it("should get solution info", async () => {
		let s = await incentiveLayer.methods.getSolutionInfo(taskID).call()

		let solutionInfo = {
			taskID: s[0],
			solutionHash0: s[1],
			taskInitHash: s[2],
			codeType: s[3],
			bundleId: s[4],
		}

		assert.equal(solutionInfo.taskID, taskID)
		assert.equal(solutionInfo.solutionHash0, solution0Hash)
		assert.equal(solutionInfo.taskInitHash, 0x0)
		assert.equal(solutionInfo.codeType, 0)
		assert.equal(solutionInfo.bundleId, 0x0)
	})

})
