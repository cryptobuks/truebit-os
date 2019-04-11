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
   function finalizeBundle(bytes32 bundleID, bytes32 codeFileID) external returns (bytes32);
   function getInitHash(bytes32 bid) external view returns (bytes32);   
   function addIPFSFile(string calldata name, uint size, string calldata hash, bytes32 root, uint nonce) external returns (bytes32);
   function hashName(string calldata name) external returns (bytes32);
   
   function createParameters(uint nonce, uint8 stack, uint8 mem, uint8 globals, uint8 table, uint8 call, uint64 limit) external returns (bytes32);
}

interface TrueBit {
   function createTask(bytes32 initTaskHash, uint difficulty) external payable returns (bytes32);
   function requireFile(bytes32 id, bytes32 hash, /* Storage */ uint8 st, uint size) external returns (uint);
   function commitRequiredFiles(bytes32 id) external;
   function makeDeposit(uint _deposit) external payable returns (uint);
   function getTaskFinality(bytes32 taskID) external returns (uint);
   function setWhitelist(address wl_addr) external;
   function getUploadNames(bytes32 id) external returns (bytes32[] memory);
   function getUploadLength(bytes32 id) external returns (uint);
   function checkUploadLength(bytes32 id) external;
}

contract Scrypt {

   event GotFiles(bytes32[] files);
   event Consuming(bytes32[] arr);
   
   event InputData(bytes32[] data);

   uint nonce;
   TrueBit truebit;
   Filesystem filesystem;

   bytes32 codeFileID;
   bytes32 pfile;

   mapping (bytes => bytes32) string_to_file; 
   mapping (bytes32 => bytes) task_to_string;
   mapping (bytes => bytes32) result;

   constructor(address tb, address fs, bytes32 _codeFileID) public {
       truebit = TrueBit(tb);
       filesystem = Filesystem(fs);
       codeFileID = _codeFileID;
       pfile = filesystem.createParameters(0, 20, 20, 8, 20, 10, 5000);
       nonce = 1;
   }

   function () external payable {}

   function submitData(bytes memory data) public returns (bytes32) {
      uint num = nonce;
      nonce++;

      bytes32 bundleID = filesystem.makeBundle(nonce);

      filesystem.addToBundle(bundleID, pfile);

      bytes32 inputFileID = filesystem.createFileFromBytes("input.data", num, data);
      string_to_file[data] = inputFileID;
      filesystem.addToBundle(bundleID, inputFileID);
      
      bytes32[] memory empty = new bytes32[](0);
      filesystem.addToBundle(bundleID, filesystem.createFileWithContents("output.data", num+1000000000, empty, 0));

      bytes32 initHash = filesystem.finalizeBundle(bundleID, codeFileID);

      bytes32 task = truebit.createTask.value(10)(initHash, 1);
      truebit.requireFile(task, filesystem.hashName("output.data"), 0, 100);
      truebit.commitRequiredFiles(task);

      task_to_string[task] = data;
      return initHash;
   }

   function debug(bytes memory data) public returns (bytes32) {
      uint num = nonce;
      nonce++;

      bytes32 bundleID = filesystem.makeBundle(nonce);
      
      bytes32 inputFileID = filesystem.createFileFromBytes("input.data", num, data);
      string_to_file[data] = inputFileID;
      filesystem.addToBundle(bundleID, inputFileID);
      
      bytes32[] memory empty = new bytes32[](0);
      filesystem.addToBundle(bundleID, filesystem.createFileWithContents("output.data", num+1000000000, empty, 0));
      
      filesystem.finalizeBundle(bundleID, codeFileID);
      
      return filesystem.getInitHash(bundleID);
   }

   bytes32 remember_task;

   // this is the callback name
   function solved(bytes32 id, bytes32[] calldata files) external returns (uint) {
      emit GotFiles(files);
      // could check the task id
      require(TrueBit(msg.sender) == truebit);
      remember_task = id;
      bytes32[] memory arr = filesystem.getData(files[0]);
      emit Consuming(arr);
      result[task_to_string[remember_task]] = arr[0];
      return 123;
   }

   // need some way to get next state, perhaps shoud give all files as args
   function scrypt(bytes memory data) public view returns (bytes32) {
      return result[data];
   }
   
}
