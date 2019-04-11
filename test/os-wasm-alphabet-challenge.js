const assert = require('assert')

const timeout = require('../os/lib/util/timeout')

const BigNumber = require('bignumber.js')

const mineBlocks = require('../os/lib/util/mineBlocks')

const fs = require('fs')

const logger = require('../os/logger')

let os, accounting, taskSubmitter

before(async () => {
    os = await require('../os/kernel')("./wasm-client/config.json")
    accounting = await require('../os/lib/util/accounting')(os)    
})

describe('Truebit OS WASM Alphabet Challenge', async function() {
    this.timeout(600000)

    it('should have a logger', () => {
	assert(os.logger)
    })

    it('should have a web3', () => {
	assert(os.web3)
    })

    it('should have a solver', () => {
    	assert(os.solver)
    })

    it('should have a verifier', () => {
    	assert(os.verifier)
    })
    
    describe('Normal task lifecycle', async () => {
	let killTaskGiver
	let killSolver
	let killVerifier

	let tgBalanceEth, sBalanceEth, tgBalanceTru, sBalanceTru, vBalanceEth, vBalanceTru	

	before(async () => {
	    taskSubmitter = await require('../wasm-client/ss_taskSubmitter')(os.web3, os.logger, os.fileSystem)
	    
	    killSolver = await os.solver.init(os, os.accounts[0])
	    killVerifier = await os.verifier.init(os, os.accounts[0], true)

	    tgBalanceEth = await accounting.ethBalance(os.accounts[1])
	    sBalanceEth = await accounting.ethBalance(os.accounts[0])

	    tgBalanceTru = await accounting.truBalance(os.accounts[1])
	    sBalanceTru = await accounting.truBalance(os.accounts[0])
	})

	after(async () => {
	    killSolver()
	    killVerifier()

	    await accounting.ethReportDif(tgBalanceEth, os.accounts[1], "TaskGiver")
	    await accounting.ethReportDif(sBalanceEth, os.accounts[0], "Solver")

	    await accounting.truReportDif(tgBalanceTru, os.accounts[1], "TaskGiver")
		await accounting.truReportDif(sBalanceTru, os.accounts[0], "Solver")

		os.web3.currentProvider.disconnect()
	})

	it('should submit task', async () => {

	    let exampleTask = {
		"minDeposit": "1",
		"codeType": "WASM",
		"storageType": "IPFS",
		"codeFile": "/data/reverse_alphabet.wasm",
		"inputFile": "/data/alphabet.txt",
		"reward": "1",
		"maxDifficulty": "1",
		"files": ["/data/config", "/data/alphabet.txt", "/data/reverse_alphabet.txt"]
	    }

	    //simulate cli by adding from account and translate reward

	    exampleTask["from"] = os.accounts[0]	    

	    await taskSubmitter.submitTask(exampleTask)

	    await timeout(8000)
	    await mineBlocks(os.web3, 12)
	    await timeout(5000)
	    await mineBlocks(os.web3, 5)
        await timeout(60000)
	    
	})
	
	// it('should have a higher balance', async () => {

	//     await mineBlocks(os.web3, 110)

	//     await timeout(5000)

	//     const newBalance = new BigNumber(await os.web3.eth.getBalance(os.accounts[1]))
	//     console.log(newBalance)
	//     console.log(originalBalance)
	//     assert(originalBalance.isLessThan(newBalance))
	// })
    })
})
