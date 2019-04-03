const BigNumber = require('bignumber.js')
const contractsConfig = require('../../../wasm-client/util/contractsConfig')

module.exports = async (os) => {

    const config = await contractsConfig(os.web3)
    const tru = new os.web3.eth.Contract(config['tru'].abi, config['tru'].address)
    
    return {
	ethBalance: async (account) => {
	    return new BigNumber(await os.web3.eth.getBalance(account))
	},
	ethReportDif: async (original, account, name) => {
	    let newBalance = new BigNumber(await os.web3.eth.getBalance(account))
	    let dif = newBalance.minus(original)

	    let amount = os.web3.utils.fromWei(dif.toString(), 'ether') 
	    console.log(name + " balance change ETH: " + amount)
	},
	truBalance: async (account) => {
	    return new BigNumber(await tru.methods.balanceOf(account).call())
	},
	truReportDif: async (original, account, name) => {
	    let newBalance = new BigNumber(await tru.methods.balanceOf(account).call())

	    let dif = newBalance.minus(original)

	    let amount = os.web3.utils.fromWei(dif.toString(), 'ether') 
	    console.log(name + " balance change TRU: " + amount)
	    
	}
    }
}
