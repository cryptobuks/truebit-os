pragma solidity ^0.5.0;

contract IpfsRegister {
    event Register(string addr, address eaddr);
    constructor () public {
    }
    function register(string memory addr) public {
        emit Register(addr, msg.sender);
    }
}

