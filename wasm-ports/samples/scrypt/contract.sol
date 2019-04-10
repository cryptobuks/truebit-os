pragma solidity ^0.5.0;

import "../ifaces.sol";

contract SampleContract {

   event NewTask(bytes data);
   event FinishedTask(bytes data, bytes32 result);

   uint nonce;
   TrueBit truebit;
   Filesystem filesystem;

   bytes32 codeFileID;

   mapping (bytes => bytes32) string_to_file; 
   mapping (bytes32 => bytes) task_to_string;
   mapping (bytes => bytes32) result;

   uint8 memsize;
   uint32 gas;
   bytes32 pfile;

   constructor(address tb, address fs, bytes32 _codeFileID, uint8 _memsize, uint32 _gas) public {
      truebit = TrueBit(tb);
      filesystem = Filesystem(fs);
      codeFileID = _codeFileID;
      memsize = _memsize;
      gas = _gas;
      pfile = filesystem.createParameters(0, 20, 20, 8, 20, 10, 5000);
      nonce = 1;
   }

   function () external payable {}

   function submitData(bytes memory data) public returns (bytes32) {
      uint num = nonce;
      nonce++;

      bytes32 bundleID = filesystem.makeBundle(num);

      filesystem.addToBundle(bundleID, pfile);

      bytes32 inputFileID = filesystem.createFileFromBytes("input.data", num, data);
      string_to_file[data] = inputFileID;
      filesystem.addToBundle(bundleID, inputFileID);
      
      bytes32[] memory empty = new bytes32[](0);
      filesystem.addToBundle(bundleID, filesystem.createFileWithContents("output.data", num+1000000000, empty, 0));
      
      filesystem.finalizeBundle(bundleID, codeFileID);

      bytes32 task = truebit.createTaskWithParams.value(10)(filesystem.getInitHash(bundleID), 1, bundleID, 1, 20, memsize, 8, 20, 10, gas);
      truebit.requireFile(task, filesystem.hashName("output.data"), 0);
      truebit.commitRequiredFiles(task);
      task_to_string[task] = data;
      emit NewTask(data);

      return filesystem.getInitHash(bundleID);
   }

   // this is the callback name
   function solved(bytes32 id, bytes32[] memory files) public {
      // could check the task id
      require(TrueBit(msg.sender) == truebit);
      bytes32[] memory arr = filesystem.getData(files[0]);
      result[task_to_string[id]] = arr[0];
      emit FinishedTask(task_to_string[id], arr[0]);
   }

   // need some way to get next state, perhaps shoud give all files as args
   function scrypt(bytes memory data) public view returns (bytes32) {
      return result[data];
   }

}
