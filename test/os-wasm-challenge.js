const assert = require('assert')
const timeout = require('../os/lib/util/timeout')
const mineBlocks = require('../os/lib/util/mineBlocks')

let os

let taskSubmitter

before(async () => {
    os = await require('../os/kernel')("./wasm-client/config.json")
    accounting = await require('../os/lib/util/accounting')(os)        
})

describe('Truebit OS WASM Challenge', async function() {
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
    
    describe('Task lifecycle with challenge', async () => {
	let killSolver
	let killVerifier

	let tgBalanceEth, sBalanceEth, tgBalanceTru, sBalanceTru, vBalanceEth, vBalanceTru	
	

	before(async () => {
	    taskSubmitter = await require('../wasm-client/ss_taskSubmitter')(os.web3, os.logger)
	    
	    killSolver = await os.solver.init(os, os.accounts[0], os)
	    killVerifier = await os.verifier.init(os, os.accounts[2], os, undefined, true, 1)

	    tgBalanceEth = await accounting.ethBalance(os.accounts[1])
	    sBalanceEth = await accounting.ethBalance(os.accounts[0])
	    vBalanceEth = await accounting.ethBalance(os.accounts[2])	    

	    tgBalanceTru = await accounting.truBalance(os.accounts[1])
	    sBalanceTru = await accounting.truBalance(os.accounts[0])
	    vBalanceTru = await accounting.truBalance(os.accounts[2])	 	    
	})

	after(async () => {
	    killSolver()
	    killVerifier()

	    await accounting.ethReportDif(tgBalanceEth, os.accounts[1], "TaskGiver")
	    await accounting.ethReportDif(sBalanceEth, os.accounts[0], "Solver")
	    await accounting.ethReportDif(vBalanceEth, os.accounts[2], "Verifier")	    

	    await accounting.truReportDif(tgBalanceTru, os.accounts[1], "TaskGiver")
	    await accounting.truReportDif(sBalanceTru, os.accounts[0], "Solver")
		await accounting.truReportDif(vBalanceTru, os.accounts[2], "Verifier")
		
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

	    //simulate cli by adding from account and translate reward

	    exampleTask["from"] = os.accounts[1]

	    await taskSubmitter.submitTask(exampleTask)

	    await timeout(8000)
	    // console.log("SOLVER should have committed solution")
	    // console.log("VERIFIER should have challenged by now")
	    await mineBlocks(os.web3, 15)
	    await timeout(5000)
	    await mineBlocks(os.web3, 10)
	    await timeout(30000)
	    
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
