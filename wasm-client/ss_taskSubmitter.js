const fs = require('fs')
const assert = require('assert')
const path = require('path')

const ps = require('./ps')

const readFile = (filepath) => {
    return new Promise((resolve, reject) => {
        fs.readFile(filepath, (err, res) => {
            if (err) reject(err)
            else resolve(res)
        })
    })
}

const writeFile = (filepath, buf) => {
    return new Promise((resolve, reject) => {
        fs.writeFile(filepath, buf, (err) => {
            if (err) reject(err)
            else { resolve() }
        })
    })
}

module.exports = async (web3, logger, mcFileSystem) => {


    const merkleComputer = require('./merkle-computer')(logger, '../../ocaml-offchain/interpreter/wasm')

    const typeTable = {
        "WAST": merkleComputer.CodeType.WAST,
        "WASM": merkleComputer.CodeType.WASM
    }

    let [incentiveLayer, tbFileSystem] = await ps.setup(web3)

    //Two filesystems (which may be confusing)
    //tbFileSystem is the Truebit filesystem contract
    //mcFileSystem is a module for ipfs helpers from merkleComputer module


    async function uploadOnchain(codeData, options) {
        return merkleComputer.uploadOnchain(codeData, web3, options)
    }

    async function getInitHash(config, path) {

        vm = merkleComputer.init(config, path)

        let interpreterArgs = []

        let initHash = (await vm.initializeWasmTask(interpreterArgs)).hash

        return initHash
    }

    async function getCodeRoot(config, path) {

        vm = merkleComputer.init(config, path)

        let interpreterArgs = []

        let codeRoot = (await vm.initializeWasmTask(interpreterArgs)).vm.code

        return codeRoot
    }

    async function makeBundle(account) {
        let bundleNonce = Math.floor(Math.random() * Math.pow(2, 60)).toString()
        let bundleId = await tbFileSystem.methods.calcId(bundleNonce).call({ from: account })

        await tbFileSystem.methods.makeBundle(bundleNonce).call({ from: account, gas: 300000 })

        logger.info(`Made bundle ${bundleId}`)

        return bundleId
    }

    async function uploadIPFS(codeBuf, config, from, dirPath) {
        assert(Buffer.isBuffer(codeBuf))

        let bundleID = await makeBundle(from)

        let ipfsFile = (await mcFileSystem.upload(codeBuf, "task.wast"))[0]

        let ipfsHash = ipfsFile.hash
        let name = ipfsFile.path

        let randomNum = Math.floor(Math.random() * Math.pow(2, 60)).toString()
        let size = codeBuf.byteLength
        let codeRoot = await getCodeRoot(config, dirPath)

        let fileRoot = merkleComputer.merkleRoot(web3, codeBuf)

        let codeFileID = await tbFileSystem.methods.calcId(randomNum).call({ from: from })

        await tbFileSystem.methods.addIPFSFile(name, size, ipfsHash, fileRoot, randomNum).send({ from: from, gas: 300000 })

        await tbFileSystem.methods.setCodeRoot(codeFileID, codeRoot, config.code_type).send({ from: from, gas: 100000 })

        await tbFileSystem.methods.finalizeBundle(bundleID, codeFileID).send({ from: from, gas: 1000000 })

        let initHash = await tbFileSystem.methods.finalizeBundle(bundleID, codeFileID).call({ from: from, gas: 1000000 })

        return [bundleID, initHash]
    }

    async function uploadIPFSFiles(codeBuf, config, from, dirPath) {
        assert(Buffer.isBuffer(codeBuf))

        let bundleID = await makeBundle(from)

        let ipfsFile = (await mcFileSystem.upload(codeBuf, "task.wast"))[0]

        let ipfsHash = ipfsFile.hash
        let codeName = ipfsFile.path
        let codeSize = ipfsFile.size

        let newFiles = []

        for (let i = 0; i < config.files.length; i++) {
            let filePath = config.files[i]
            let fileBuf = await readFile(process.cwd() + filePath)

            let fileName = path.basename(filePath)
            let newFilePath = dirPath + "/" + fileName
            newFiles.push(newFilePath)

            await writeFile(newFilePath, fileBuf)

            let fileSize = fileBuf.byteLength
            let fileRoot = merkleComputer.merkleRoot(web3, fileBuf)

            let fileNonce = Math.floor(Math.random() * Math.pow(2, 60)).toString()

            let fileIPFSHash = (await mcFileSystem.upload(fileBuf, "bundle/" + fileName))[0].hash

            let fileID = await tbFileSystem.methods.calcId(fileNonce).call({ from: from })

            await tbFileSystem.methods.addIPFSFile(
                fileName,
                fileSize,
                fileIPFSHash,
                fileRoot,
                fileNonce).send({ from: from, gas: 200000 })

            await tbFileSystem.methods.addToBundle(bundleID, fileID).send({ from: from, gas: 100000 })
        }

        let randomNum = Math.floor(Math.random() * Math.pow(2, 60)).toString()
        let codeFileId = await tbFileSystem.methods.calcId(randomNum).call({ from: from })

        config.files = newFiles

        let codeRoot = await getCodeRoot(config, dirPath)
        let fileRoot = merkleComputer.merkleRoot(web3, codeBuf)

        await tbFileSystem.methods.addIPFSFile(codeName, codeSize, ipfsHash, fileRoot, randomNum).send({ from: from, gas: 300000 })
        await tbFileSystem.methods.setCodeRoot(codeFileId, codeRoot, config.code_type).send({ from: from, gas: 300000 })

        await tbFileSystem.methods.finalizeBundle(bundleID, codeFileId).send({ from: from, gas: 1500000 })

        let initHash = await tbFileSystem.methods.finalizeBundle(bundleID, codeFileId).call({ from: from, gas: 1500000 })

        return [bundleID, initHash]
    }

    //This also creates a directory for the random path if it doesnt exist

    function setupTaskConfiguration(task) {
        task.codeType = typeTable[task.codeType]

        if (!task.files) {
            task.files = []
        }

        if (!task.inputFile) {
            task.inputFile = ""
        } else {
            task.inputFile = process.cwd() + task.inputFile
        }

        let codeBuf = fs.readFileSync(process.cwd() + task.codeFile)

        let randomPath = process.cwd() + "/tmp/giver_" + Math.floor(Math.random() * Math.pow(2, 60)).toString(32)

        if (!fs.existsSync(randomPath)) fs.mkdirSync(randomPath)
        fs.writeFileSync(randomPath + "/" + path.basename(task.codeFile), codeBuf)


        let config = {
            code_file: path.basename(task.codeFile),
            input_file: task.inputFile,
            actor: {},
            files: task.files,
            code_type: task.codeType
        }

        return [config, randomPath, codeBuf]

    }

    async function submitTask_aux(task) {

        let [config, randomPath, codeBuf] = setupTaskConfiguration(task)

        if (task.storageType == "IPFS") {

            if (task.files == []) {
                let [bundleID, initHash] = await uploadIPFS(codeBuf, config, task.from, randomPath)

                task.bundleID = bundleID
                task.initHash = initHash
            } else {
                let [bundleID, initHash] = await uploadIPFSFiles(codeBuf, config, task.from, randomPath)
                task.bundleID = bundleID
                task.initHash = initHash
            }

            logger.info(`Uploaded data to IPFS`)

        } else { //store file on blockchain

            let contractAddress = await uploadOnchain(codeBuf, { from: task.from, gas: 4000000 })

            logger.info(`Uploaded data onchain`)

            let codeRoot = await getCodeRoot(config, randomPath)
            let fileRoot = merkleComputer.merkleRoot(web3, codeBuf)
            let codeFileNonce = Math.floor(Math.random() * Math.pow(2, 60)).toString()
            let codeFileId = await tbFileSystem.methods.calcId(codeFileNonce).call({ from: task.from })
            // let codeFileId2 = await tbFileSystem.calcId.call(codeFileNonce)
            // console.log("code file nonce", codeFileNonce, codeFileId, codeFileId2, task.from)

            let size = Buffer.byteLength(codeBuf, 'utf8');

            await tbFileSystem.methods.addContractFile("task.wasm", codeFileNonce, contractAddress, fileRoot, size).send({ from: task.from, gas: 300000 })
            await tbFileSystem.methods.setCodeRoot(codeFileId, codeRoot, 0).send({ from: task.from, gas: 100000 })

            let bundleID = await makeBundle(task.from)

            await tbFileSystem.methods.finalizeBundle(bundleID, codeFileId).send({ from: task.from, gas: 3000000 })
            let initHash = await tbFileSystem.methods.finalizeBundle(bundleID, codeFileId).call({ from: task.from, gas: 3000000 })

            logger.info(`Registered deployed contract with Truebit filesystem`)

            task.bundleID = bundleID
            task.initHash = initHash
        }

        task.reward = web3.utils.toWei(task.reward, 'ether')

        logger.info(`Submitting task`)

        // console.log(task.initHash,task.codeType,task.bundleID,1)

        var id = await incentiveLayer.methods.createSimpleTask(task.initHash).send({ gas: 1000000, from: task.from, value: task.reward })

        logger.info('Task was created')

        return id

    }

    return {

        getInitialHash: async (task) => {

            let [config, randomPath, codeBuf] = setupTaskConfiguration(task)

            let initHash

            if (task.files == []) {
                initHash = await getInitHash(config, randomPath)
            } else {
                initHash = await getInitHash(config, randomPath)
            }

            return initHash

        },

        submitTask: async (task) => {
            try {
                return await submitTask_aux(task)
            }
            catch (e) {
                logger.error(`Cannot create task: ${e}`)
            }
        }
    }
}
