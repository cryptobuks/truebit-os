pragma solidity ^0.5.0;

interface Filesystem {

   function createFileWithContents(string calldata name, uint nonce, bytes32[] calldata arr, uint sz) external returns (bytes32);
   function createFileFromBytes(string calldata name, uint nonce, bytes calldata arr) external returns (bytes32);

   function getSize(bytes32 id) external view returns (uint);
   function getRoot(bytes32 id) external view returns (bytes32);
   function getData(bytes32 id) external view returns (bytes32[] memory);
   function forwardData(bytes32 id, address a) external;   
   
   function makeBundle(uint num) external view returns (bytes32);
   function addToBundle(bytes32 id, bytes32 file_id) external returns (bytes32);
   function finalizeBundle(bytes32 bundleID, bytes32 codeFileID) external;
   function getInitHash(bytes32 bid) external view returns (bytes32);   
   function addIPFSFile(string calldata name, uint size, string calldata hash, bytes32 root, uint nonce) external returns (bytes32);
   function hashName(string calldata name) external returns (bytes32);
   
   function createParameters(uint nonce, uint8 stack, uint8 mem, uint8 globals, uint8 table, uint8 call, uint64 limit) external returns (bytes32);
}

interface TrueBit {
   function createTaskWithParams(bytes32 initTaskHash, uint8 codeType, bytes32 bundleID, uint maxDifficulty,
                                  uint8 stack, uint8 mem, uint8 globals, uint8 table, uint8 call, uint32 limit) external payable returns (bytes32);
   function requireFile(bytes32 id, bytes32 hash, /* Storage */ uint8 st) external returns (uint);
   function commitRequiredFiles(bytes32 id) external;
   function makeDeposit(uint _deposit) external payable returns (uint);
   function getTaskFinality(bytes32 taskID) external returns (uint);
   function setWhitelist(address wl_addr) external;
   function getUploadNames(bytes32 id) external returns (bytes32[] memory);
   function getUploadLength(bytes32 id) external returns (uint);
   function checkUploadLength(bytes32 id) external;
}
