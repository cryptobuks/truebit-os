
let argv = require('minimist')(process.argv.slice(2));

let host = argv.host || 'ws://localhost:8546'
// let host = argv.host || 'http://localhost:8545'

let parity = !!argv.parity

const Web3 = require('web3')
// const web3 = new Web3(new Web3.providers.HttpProvider(host))
const web3 = new Web3(new Web3.providers.WebsocketProvider(host))
const fs = require('fs')
const getNetwork = async () => {
    let id = await web3.eth.net.getId()
    if (id == 5) return "goerli"
    else return await web3.eth.net.getNetworkType()
}

const base = './build/'

function getArtifacts(name) {
    return {
        abi: JSON.parse(fs.readFileSync(base + name + '.abi')),
        bin: fs.readFileSync(base + name + '.bin')
    }
}

async function deployContract(name, options = {}, args = []) {
    let artifacts = getArtifacts(name)
    let contract = new web3.eth.Contract(artifacts.abi)
    let res = await contract.deploy({ data: "0x"+artifacts.bin, arguments: args }).send(options)
    res.abi = artifacts.abi
    return res
}

function exportContract(contract) {
    return {
        address: contract.options.address,
        abi: contract.abi
    }
}

async function deploy() {
    let networkName = await getNetwork(web3)
    let filename = './wasm-client/' + networkName + '.json'
    console.log("Writing to", filename)

    let accounts = await web3.eth.getAccounts()

    // console.log("accounts", accounts)

    //    console.log("bg limit", await web3.eth.getBlock(1))

    let ipfsRegister = await deployContract('IpfsRegister', { from: accounts[0], gas: 5500000 })
    console.log("IPFS Register", ipfsRegister.options.address)

    let fileSystem = await deployContract('Filesystem', { from: accounts[0], gas: 5600000 })
    console.log("Filesystem", fileSystem.options.address)
    let judge = await deployContract('Judge', { from: accounts[0], gas: 5600000 })
    console.log("Judge", judge.options.address)

    let interactive = await deployContract('Interactive', { from: accounts[0], gas: 5500000 }, [judge.options.address])
    console.log("Interactive", interactive.options.address)

    let tru = await deployContract('TRU', { from: accounts[0], gas: 2000000 })
    console.log("TRU", tru.options.address)
    let exchangeRateOracle = await deployContract('ExchangeRateOracle', { from: accounts[0], gas: 1000000 })

    let incentiveLayer = await deployContract(
        'IncentiveLayer',
        { from: accounts[0], gas: 5200000 },
        [tru.options.address,
        exchangeRateOracle.options.address,
        interactive.options.address,
        fileSystem.options.address,
        ]
    )

    console.log("Incentive Layer", incentiveLayer.options.address)

    // tru.methods.transferOwnership(incentiveLayer._address).send({from: accounts[0], gas: 1000000})

    let wait = 0
    if (networkName == "kovan") wait = 10000
    else if (networkName == "rinkeby") wait = 15000
    else if (networkName == "goerli") wait = 15000
    else if (networkName == "ropsten") wait = 30000

    let config = {
        WAIT_TIME: wait,
        fileSystem: exportContract(fileSystem),
        judge: exportContract(judge),
        interactive: exportContract(interactive),
        tru: exportContract(tru),
        exchangeRateOracle: exportContract(exchangeRateOracle),
        incentiveLayer: exportContract(incentiveLayer),
        ipfsRegister: exportContract(ipfsRegister),
    }

    if (networkName == "private") {
        let whitelist = await deployContract('WhiteList', { from: accounts[0], gas: 2000000 })
        console.log("Test WL", whitelist.options.address)
        let stake_whitelist = await deployContract('StakeWhitelist', { from: accounts[0], gas: 2000000 })
        console.log("Stake WL", stake_whitelist.options.address)
        let testbook = await deployContract('TestBook', { from: accounts[0], gas: 2000000 })
        console.log("Test taskbook", testbook.options.address)

        let ss_incentiveLayer = await deployContract(
            'SingleSolverIncentiveLayer',
            { from: accounts[0], gas: 5200000 },
            [interactive.options.address, fileSystem.options.address, whitelist.options.address]
        )
        
        console.log("Taskbook", ss_incentiveLayer.options.address)

        await web3.eth.sendTransaction({ from: accounts[0], to: ss_incentiveLayer.options.address, value: web3.utils.toWei("2", "ether") })

        await stake_whitelist.methods.setToken(tru.options.address).send({ from: accounts[0], gas: 300000 })
        await stake_whitelist.methods.setTaskBook(testbook.options.address).send({ from: accounts[0], gas: 300000 })

        config.ss_incentiveLayer = exportContract(ss_incentiveLayer)
        config.stake_whitelist = exportContract(stake_whitelist)
        config.testbook = exportContract(testbook)

        let lst = []
        let obj = []
        for (let i = 0; i < 4; i++) {
            let w = web3.eth.accounts.create()
            web3.eth.accounts.wallet.add(w)
            lst.push(w.address)
            obj.push(w.privateKey)
            // console.log(w)
        }
        fs.writeFileSync("wallet.json", JSON.stringify(obj))

        // Mint tokens for testing
        for (let addr of lst) {
            await web3.eth.sendTransaction({ from: accounts[0], to: addr, value: web3.utils.toWei("2", "ether") })
            await tru.methods.addMinter(addr).send({ from: accounts[0], gas: 300000 })
            // let x = await tru.methods.isMinter(addr).call()
            // console.log("add minter", addr, x)
            await tru.methods.mint(addr, "100000000000000000000000").send({ from: addr, gas: 300000 })
            // await tru.methods.mint(addr, "100000000000000000000000").send({ from: accounts[0], gas: 300000 })
            // let v = await tru.methods.balanceOf(addr).call()
            // console.log("???", v)
        }
    }

    fs.writeFileSync(filename, JSON.stringify(config))

    // Set exchange rate oracle for testing, main net should come from external data source (dex, oraclize, etc..)
    // const TRUperUSD = 2000
    const TRUperUSD = 0
    await exchangeRateOracle.methods.updateExchangeRate(TRUperUSD).send({ from: accounts[0] })

    if (networkName != "ethereum") {
        await tru.methods.enableFaucet().send({ from: accounts[0], gas: 300000 })
    }

    web3.currentProvider.disconnect()

}

deploy()
