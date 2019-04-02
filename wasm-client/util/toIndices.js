module.exports = (data) => {
    return {
	low: parseInt(data[0]),
	high: parseInt(data[1]),
    }
}
