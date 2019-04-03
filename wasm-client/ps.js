
const contractsConfig = require('./util/contractsConfig')

function contract(web3, info) {
    return new web3.eth.Contract(info.abi, info.address)    
}

// handling contracts
module.exports.setup = async function (web3) {
    const config = await contractsConfig(web3)
    incentiveLayer = contract(web3, config['ss_incentiveLayer'])
    fileSystem = contract(web3, config['fileSystem'])
    disputeResolutionLayer = contract(web3, config['interactive'])
    wl = contract(web3, config['stake_whitelist'])

    return [incentiveLayer, fileSystem, disputeResolutionLayer, wl]
}

module.exports.make = async function (web3, logger, recover, account, role) {
    let res = {
        tasks: {},
        games: {},
        task_list: [],
        game_list: [],

        exiting: false,
        exited: false,
    }

    let obj = {
        account:account,
        games: () => res.game_list, 
        tasks: () => res.task_list,
        exit: () => { res.exiting = true },
        exited: () => res.exited,
        exiting: () => res.exiting,
    }

    res.ps = obj
    res.config = await contractsConfig(web3)
    res.WAIT_TIME = res.config.WAIT_TIME || 0

    res.recovery_mode = recover > 0
    res.events = []

    res.clean_list = []
    res.RECOVERY_BLOCKS = recover

    let bn = await web3.eth.getBlockNumber()

    if (res.recovery_mode) logger.info(`Recovering back to ${Math.max(0, bn - res.RECOVERY_BLOCKS)}`)

    res.addTask = function (id) {
        if (!res.tasks[id]) {
            res.tasks[id] = {}
            res.task_list.push(id)
        }
    }

    res.events = []

    res.addEvent = function (name, evC, handler) {
        if (!evC) return logger.error(`${role}: ${name} event is undefined when given to addEvent`)
        evC(async (err, result) => {
            // console.log(result)
            if (result && res.recovery_mode) {
                res.events.push({ event: result, handler })
                console.log(role, ": Recovering", result.event, "at block", result.blockNumber)
            }
            else if (result) {
                try {
                    await handler(result.returnValues)
                }
                catch (e) {
                    // console.log(e)
                    logger.error(`${role}: Error while handling ${name} event ${JSON.stringify(result)}: ${e}`)
                }
            }
            else console.log(err)
        })
    }

    let busy_table = {}
    res.busy = function (id) {
        let res = busy_table[id] && Date.now() < busy_table[id]
        return res
    }

    res.working = function (id) {
        busy_table[id] = Date.now() + res.WAIT_TIME
    }

    res.recover = function (recoverTask, recoverGame, disputeResolutionLayer, incentiveLayer, ver) {

        if (res.recovery_mode) {
            res.recovery_mode = false
            recovery.analyze(account, res.events, recoverTask, recoverGame, disputeResolutionLayer, incentiveLayer, res.game_list, res.task_list, ver)
        }
    }

    res.cleanUp = function () {
        res.task_list = res.task_list.filter(a => res.tasks[a])
        res.game_list = res.game_list.filter(a => res.games[a])
    }

    return res

}

