const assert = require('assert')
const timeout = require('../os/lib/util/timeout')
const BigNumber = require('bignumber.js')
const mineBlocks = require('../os/lib/util/mineBlocks')
const fs = require('fs')
const logger = require('../os/logger')

let os, accounting

let taskSubmitter

before(async () => {
    os = await require('../os/kernel')("./wasm-client/config.json")
    accounting = await require('../os/lib/util/accounting')(os)
})

describe('Truebit OS WASM', async function() {
    this.timeout(60000)

    it('should have a logger', () => {
	assert(os.logger)
    })

    it('should have a web3', () => {
	assert(os.web3)
    })

    it('should have a solver', () => {
    	assert(os.solver)
    })
    
    describe('Normal task lifecycle', async () => {
	let killTaskGiver
	let killSolver
	let killVerifier

	let taskID
	
	let tgBalanceEth, sBalanceEth
	let tgBalanceTru, sBalanceTru

	let storageAddress, initStateHash
	

	before(async () => {
	    taskSubmitter = await require('../wasm-client/ss_taskSubmitter')(os.web3, os.logger)
	    
	    killSolver = await os.solver.init(os, os.accounts[0])
	    sBalanceEth = await accounting.ethBalance(os.accounts[0])

	    sBalanceTru = await accounting.truBalance(os.accounts[0])
	    	    
	})

	after(async () => {
		killSolver()

	    await accounting.ethReportDif(sBalanceEth, os.accounts[0], "Solver")

	    await accounting.truReportDif(sBalanceTru, os.accounts[0], "Solver")
		os.web3.currentProvider.disconnect()
	    
	})
	
	it('should submit task', async () => {

	    let exampleTask = {
		"minDeposit": "1",
		"codeType": "WAST",
		"storageType": "BLOCKCHAIN",
		"codeFile": "/data/factorial.wast",
		"reward": "1",
		"maxDifficulty": "1"
	    }

	    //simulate cli by adding from account

	    exampleTask["from"] = os.accounts[1]	    

	    await taskSubmitter.submitTask(exampleTask)

	    await timeout(8000)
	    await mineBlocks(os.web3, 20)
	    await timeout(5000)
	    await mineBlocks(os.web3, 20)
	    await timeout(5000)
	    
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
