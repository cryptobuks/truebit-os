const assert = require('assert')

const timeout = require('../os/lib/util/timeout')

const BigNumber = require('bignumber.js')

const mineBlocks = require('../os/lib/util/mineBlocks')

const fs = require('fs')

const logger = require('../os/logger')

const contractsConfig = require('../wasm-client/util/contractsConfig')
const merkleComputer = require('../wasm-client/merkle-computer')()

let os, accounting

const config = JSON.parse(fs.readFileSync("./wasm-client/config.json"))
const info = JSON.parse(fs.readFileSync("./scrypt-data/info.json"))

let account
let web3

function contract(web3, info) {
    return new web3.eth.Contract(info.abi, info.address)    
}

const ipfs = require('ipfs-api')(config.ipfs.host, '5001', { protocol: 'http' })
const fileSystem = merkleComputer.fileSystem(ipfs)

before(async () => {
	os = await require('../os/kernel')("./wasm-client/config.json")
	accounting = await require('../os/lib/util/accounting')(os)

	account = os.accounts[1]
	web3 = os.web3
})

describe('Truebit OS WASM Scrypt test', async function () {
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

	let tbFilesystem, tru

	describe('Normal task lifecycle', async () => {
		let killSolver

		let initStateHash, bundleID, cConfig, codeFileID, taskID

		before(async () => {
			cConfig = await contractsConfig(web3)
			tbFilesystem = contract(web3, cConfig['fileSystem'])
			// tru = contract(web3.currentProvider, cConfig['tru'])
			killSolver = await os.solver.init(os, os.accounts[0])

			tgBalanceEth = await accounting.ethBalance(account)
			sBalanceEth = await accounting.ethBalance(os.accounts[0])

			tgBalanceTru = await accounting.truBalance(account)
			sBalanceTru = await accounting.truBalance(os.accounts[0])
		})

		after(async () => {
			killSolver()

			await accounting.ethReportDif(tgBalanceEth, account, "TaskGiver")
			await accounting.ethReportDif(sBalanceEth, os.accounts[0], "Solver")

			await accounting.truReportDif(tgBalanceTru, account, "TaskGiver")
			await accounting.truReportDif(sBalanceTru, os.accounts[0], "Solver")

			os.web3.currentProvider.disconnect()

		})

		it("should create a bundle", async () => {
			let nonce = Math.floor(Math.random() * Math.pow(2, 60)).toString()
			bundleID = await tbFilesystem.methods.calcId(nonce).call({from:account})
			await tbFilesystem.methods.makeBundle(nonce).send({ from: account, gas: 300000 })
		})

		it('should upload task code', async () => {
			let codeBuf = fs.readFileSync("./scrypt-data/task.wasm")
			let ipfsFile = (await fileSystem.upload(codeBuf, "task.wasm"))[0]

			let ipfsHash = ipfsFile.hash
			let size = ipfsFile.size
			let name = ipfsFile.path

			let merkleRoot = merkleComputer.merkleRoot(os.web3, codeBuf)
			let nonce = Math.floor(Math.random() * Math.pow(2, 60)).toString()

			assert.equal(ipfsHash, info.ipfshash)

			codeFileID = await tbFilesystem.methods.calcId(nonce).call({from:account})

			await tbFilesystem.methods.addIPFSCodeFile(name, size, ipfsHash, merkleRoot, info.codehash, nonce).send({ from: account, gas: 300000 })
		})

		let scrypt_contract
		let scrypt_result

		async function deployContract(abi, bin, args = [], options = {}) {
			let contract = new web3.eth.Contract(abi)
			return await contract
				.deploy({ data: "0x" + bin, arguments: args })
				.send(options)
		}

		it('should deploy test contract', async () => {

			let abi = JSON.parse(fs.readFileSync("./scrypt-data/compiled/Scrypt.abi"))

			scrypt_contract = await deployContract(
				abi,
				fs.readFileSync("./scrypt-data/compiled/Scrypt.bin"),
				[cConfig.ss_incentiveLayer.address, cConfig.fileSystem.address, bundleID, codeFileID, info.codehash],
				{ from: account, gas: 2000000 })
			
				await web3.eth.sendTransaction({to:scrypt_contract.options.address, value:"1000000000000000000", from: os.accounts[0], gas: 200000 })
				/*
				await scrypt_contract.methods.weird("0x00").send({ from: account, gas: 2000000 })
				await scrypt_contract.methods.weird("0x00").send({ from: account, gas: 2000000 })
				await scrypt_contract.methods.weird("0x00").send({ from: account, gas: 2000000 })
				await scrypt_contract.methods.weird("0x00").send({ from: account, gas: 2000000 })
			console.log(await scrypt_contract.methods.weird("0x00").call({ from: account, gas: 2000000 }))
*/

			//	scrypt_contract.once("GotFiles", async ev => {
			scrypt_contract.events.GotFiles(async (err,ev) => {
				console.log("got event, file ID", ev.returnValues.files[0])
				let fileid = ev.returnValues.files[0]
				var lst = await tbFilesystem.methods.getData(fileid).call()
				console.log("got stuff", lst)
				scrypt_result = lst[0]
			})
		})

		it('should submit task', async () => {
			let str = "0x" + Buffer.from("testing").toString("hex")
			await scrypt_contract.methods.submitData(str).send({ from: account, gas: 4000000 })
		})

		it('wait for task', async () => {

			await timeout(25000)
			await mineBlocks(os.web3, 20)
			await timeout(5000)
			await mineBlocks(os.web3, 20)
			await timeout(5000)

			await mineBlocks(os.web3, 10)
			await timeout(5000)

			assert.equal(scrypt_result, '0x78b512d6425a6fe9e45baf14603bfce1c875a6962db18cc12ecf4292dbd51da6')

		})
	
	})
})
