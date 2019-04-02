module.exports = (data) => {
    return {
	giver: data[0],
	initStateHash: data[1],
	codeType: parseInt(data[2]),
	bundleId: data[3],
	uniqueNum: data[4]
    }
}
