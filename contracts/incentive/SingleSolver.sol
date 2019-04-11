pragma solidity ^0.5.0;

import "../filesystem/Filesystem.sol";
import "../openzeppelin-solidity/Ownable.sol";

import "../interface/IGameMaker.sol";
import "../interface/IDisputeResolutionLayer.sol";

interface Callback {
    function solved(bytes32 taskID, bytes32[] calldata files) external;
    function cancelled(bytes32 taskID) external;
}

interface IWhiteList {
    function approved(bytes32 taskID, address solver) external returns (bool);
}

contract WhiteList is IWhiteList {
    address private owner;
    constructor () public {
        owner = msg.sender;
    }

    function approved(bytes32 /* taskID */, address solver) external returns (bool) {
        return solver == owner;
    }

}

interface ITruebit {
    function isFailed(bytes32 taskID) external view returns (bool);
    function isFinalized(bytes32 taskID) external view returns (bool);
    function getBlock(bytes32 taskID) external view returns (uint);
    function getSolution(bytes32 taskID) external view returns (bytes32);
}

contract SingleSolverIncentiveLayer is Ownable, ITruebit {

    uint private numTasks = 0;
    uint private taxMultiplier = 5;

    uint constant BASIC_TIMEOUT = 5;
    uint constant IPFS_TIMEOUT = 5;
    uint constant GAME_TIMEOUT = 100;
    uint constant INTERPRET_RATE = 10;

    uint constant SOLVER_DEPOSIT = 0.1 ether;
    uint constant VERIFIER_DEPOSIT = 0.01 ether;

    enum StorageType {
        IPFS,
        BLOCKCHAIN
    }

    mapping (address => uint) deposits;

    function makeDeposit() public payable {
        deposits[msg.sender] += msg.value;
    }

    function getDeposit(address a) public view returns (uint) {
        return deposits[a];
    }

    function () payable external {
        deposits[msg.sender] += msg.value;
    }

    function withdrawDeposit() public payable {
        uint v = deposits[msg.sender];
        deposits[msg.sender] = 0;
        msg.sender.transfer(v);
    }

    event SlashedDeposit(bytes32 taskID, address account, address opponent, uint amount);
    event TaskCreated(bytes32 taskID, uint blockNumber, uint reward, address giver, bytes32 initHash);
    event SolutionsCommitted(bytes32 taskID, address giver, bytes32 initHash, bytes32 solutionHash);
    event SolutionRevealed(bytes32 taskID);
    event VerificationCommitted(bytes32 taskID, address verifier, uint index);
    event VerificationGame(address indexed solver, uint currentChallenger); 
    event PayReward(address indexed solver, uint reward);

    event EndRevealPeriod(bytes32 taskID);
    event EndChallengePeriod(bytes32 taskID);
    event TaskFinalized(bytes32 taskID, bool ok, bytes info, address owner);

    enum State { TaskInitialized, SolverSelected, SolutionCommitted, ChallengesAccepted, IntentsRevealed, SolutionRevealed, TaskFinalized, TaskTimeout }
    enum Status { Uninitialized, Challenged, Unresolved, SolverWon, ChallengerWon }//For dispute resolution
    
    struct RequiredFile {
        bytes32 nameHash;
        StorageType fileStorage;
        bytes32 fileId;
        uint maxSize;
    }
    
    struct Task {
        address payable owner;
        address giver;
        uint reward;
        bytes32 initTaskHash;
        State state;
        uint difficulty; // how many blocks the computation can take

        bool requiredCommitted;
        RequiredFile[] uploads;
        
        uint timeoutBlock;
        uint challengeTimeout;
        uint initBlock;
    }

    struct Solution {
        bytes32 solutionHash;
        address payable [] allChallengers;
        address payable currentChallenger;
        bool solverConvicted;
        bytes32 currentGame;
        
        bytes32 dataHash;
        bytes32 sizeHash;
        bytes32 nameHash;
    }

    mapping(bytes32 => Task) private tasks;
    mapping(bytes32 => Solution) private solutions;
    mapping (bytes32 => uint) challenges;    

    address disputeResolutionLayer; //using address type because in some cases it is IGameMaker, and others IDisputeResolutionLayer
    Filesystem fs;
    IWhiteList whitelist;

    constructor (address _disputeResolutionLayer, address fs_addr, address wl_addr) 
        public 
    {
        disputeResolutionLayer = _disputeResolutionLayer;
        fs = Filesystem(fs_addr);
        whitelist = IWhiteList(wl_addr);
    }

    // TODO: unsafe
    function setWhitelist(address wl_addr) public {
        whitelist = IWhiteList(wl_addr);
    }
/*
    function defaultParameters(bytes32 taskID) internal {
        VMParameters storage params = vmParams[taskID];
        params.stackSize = 14;
        params.memorySize = 16;
        params.globalsSize = 8;
        params.tableSize = 8;
        params.callSize = 10;
        params.gasLimit = 0;
    }
*/
    // @dev – taskGiver creates tasks to be solved.
    // @param minDeposit – the minimum deposit required for engaging with a task as a solver or verifier.
    // @param reward - the payout given to solver
    // @param taskData – tbd. could be hash of the wasm file on a filesystem.
    // @param numBlocks – the number of blocks to adjust for task difficulty
    // @return – boolean
    function createTaskAux(bytes32 initTaskHash, uint difficulty, uint reward) internal returns (bytes32) {
        // Get minDeposit required by task
	    require(reward > 0);

        bytes32 id = keccak256(abi.encodePacked(initTaskHash, reward, numTasks));
        numTasks++;

        Task storage t = tasks[id];
        t.giver = msg.sender;
        t.reward = reward;

        t.initTaskHash = initTaskHash;
        t.difficulty = difficulty;
        /*
        t.codeType = codeType;
        t.bundleId = bundleId;
        */

        t.timeoutBlock = block.number + IPFS_TIMEOUT + BASIC_TIMEOUT;
        t.initBlock = block.number;
        return id;
    }

    // @dev – taskGiver creates tasks to be solved.
    // @param minDeposit – the minimum deposit required for engaging with a task as a solver or verifier.
    // @param reward - the payout given to solver
    // @param taskData – tbd. could be hash of the wasm file on a filesystem.
    // @param numBlocks – the number of blocks to adjust for task difficulty
    // @return – boolean
    function createSimpleTask(bytes32 initTaskHash) public payable returns (bytes32) {
        bytes32 id = createTaskAux(initTaskHash, 0, msg.value);
	    commitRequiredFiles(id);
        
        return id;
    }

    function createTask(bytes32 initTaskHash, uint difficulty) public payable returns (bytes32) {
        bytes32 id = createTaskAux(initTaskHash, difficulty, msg.value);
        /*
        VMParameters storage param = vmParams[id];
        require(stack > 5 && mem > 5 && globals > 5 && table > 5 && call > 5);
        require(stack < 30 && mem < 30 && globals < 30 && table < 30 && call < 30);
        param.stackSize = stack;
        param.memorySize = mem;
        param.globalsSize = globals;
        param.tableSize = table;
        param.callSize = call;
        param.gasLimit = limit;
        */
        return id;
    }

    function requireFile(bytes32 id, bytes32 hash, StorageType st, uint maxSize) public returns (uint) {
        Task storage t = tasks[id];
        require (!t.requiredCommitted && msg.sender == t.giver);
        t.uploads.push(RequiredFile(hash, st, 0, maxSize));
        // require(t.uploads.length > 0);
        return t.uploads.length;
    }
    
    function commitRequiredFiles(bytes32 id) public {
        Task storage t = tasks[id];
        require (msg.sender == t.giver);
        t.requiredCommitted = true;
        emit TaskCreated(id, t.timeoutBlock, t.reward, t.giver, t.initTaskHash);
    }
    
    function getUploadLength(bytes32 id) public view returns (uint) {
        RequiredFile[] storage lst = tasks[id].uploads;
        return lst.length;
    }

    function getUploadNames(bytes32 id) public view returns (bytes32[] memory) {
        RequiredFile[] storage lst = tasks[id].uploads;
        bytes32[] memory arr = new bytes32[](lst.length);
        for (uint i = 0; i < arr.length; i++) arr[i] = lst[i].nameHash;
        return arr;
    }

    function getUploadSizes(bytes32 id) public view returns (uint[] memory) {
        RequiredFile[] storage lst = tasks[id].uploads;
        uint[] memory arr = new uint[](lst.length);
        for (uint i = 0; i < arr.length; i++) arr[i] = lst[i].maxSize;
        return arr;
    }

    function getUploadTypes(bytes32 id) public view returns (StorageType[] memory) {
        RequiredFile[] storage lst = tasks[id].uploads;
        StorageType[] memory arr = new StorageType[](lst.length);
        for (uint i = 0; i < arr.length; i++) arr[i] = lst[i].fileStorage;
        return arr;
    }

    // @dev – selected solver submits a solution to the exchange
    // 1 -> 2
    // @param taskID – the task id.
    // @param solutionHash0 – the hash of the solution (could be true or false solution)
    // @return – boolean
    function commitSolution(bytes32 taskID, bytes32 solutionHash0) public returns (bool) {
        Task storage t = tasks[taskID];
        // VMParameters storage vm = vmParams[taskID];

        require(!(t.giver == address(0x0)));
        require(t.state == State.TaskInitialized);

        require(whitelist.approved(taskID, msg.sender));

        require(deposits[msg.sender] > SOLVER_DEPOSIT);

        t.owner = msg.sender;

        deposits[msg.sender] -= SOLVER_DEPOSIT;

        Solution storage s = solutions[taskID];
        s.solutionHash = solutionHash0;
        s.solverConvicted = false;
        t.state = State.SolutionCommitted;
        t.timeoutBlock = block.number + BASIC_TIMEOUT + IPFS_TIMEOUT + (1+t.difficulty);
        t.challengeTimeout = t.timeoutBlock; // End of challenge period
        emit SolutionsCommitted(taskID, t.giver, t.initTaskHash, solutionHash0);
        return true;
    }

    function cancelTask(bytes32 taskID) internal {
        Task storage t = tasks[taskID];
        t.state = State.TaskTimeout;
        bool ok;
        bytes memory res;
        (ok, res) = t.giver.call(abi.encodeWithSignature("cancel(bytes32)", taskID));
    }

    function slashOwner(bytes32 taskID, address recp) internal {
        Solution storage s = solutions[taskID];
        for (uint i = 0; i < s.allChallengers.length; i++) {
            if (s.allChallengers[i] != address(0)) {
                deposits[s.allChallengers[i]] += VERIFIER_DEPOSIT;
            }
            s.allChallengers[i] = address(0);
        }
        deposits[recp] += SOLVER_DEPOSIT + VERIFIER_DEPOSIT;
        emit SlashedDeposit(taskID, owner, recp, SOLVER_DEPOSIT);
    }

    function slashVerifier(bytes32 taskID, address verifier) internal {
        Task storage t = tasks[taskID];
        deposits[t.owner] += VERIFIER_DEPOSIT;
        emit SlashedDeposit(taskID, verifier, owner, VERIFIER_DEPOSIT);
    }

    function payReward(bytes32 taskID) internal {
        Task storage t = tasks[taskID];
        deposits[t.owner] += t.reward;
        deposits[t.owner] += SOLVER_DEPOSIT;
    }

    function taskTimeout(bytes32 taskID) public {
        Task storage t = tasks[taskID];
        Solution storage s = solutions[taskID];
        uint g_timeout = IDisputeResolutionLayer(disputeResolutionLayer).timeoutBlock(s.currentGame);
        require(block.number > g_timeout + BASIC_TIMEOUT);
        require(block.number > t.timeoutBlock + BASIC_TIMEOUT);
        require(t.state != State.TaskTimeout);
        require(t.state != State.TaskFinalized);
        cancelTask(taskID);
        slashOwner(taskID, s.currentChallenger);
    }

    function isTaskTimeout(bytes32 taskID) public view returns (bool) {
        Task storage t = tasks[taskID];
        Solution storage s = solutions[taskID];
        uint g_timeout = IDisputeResolutionLayer(disputeResolutionLayer).timeoutBlock(s.currentGame);
        if (block.number <= g_timeout + BASIC_TIMEOUT) return false;
        if (t.state == State.TaskTimeout) return false;
        if (t.state == State.TaskFinalized) return false;
        if (block.number <= t.timeoutBlock + BASIC_TIMEOUT) return false;
        return true;
    }

    function solverLoses(bytes32 taskID) public returns (bool) {
        // Task storage t = tasks[taskID];
        Solution storage s = solutions[taskID];
        if (IDisputeResolutionLayer(disputeResolutionLayer).status(s.currentGame) == uint(Status.ChallengerWon)) {
            cancelTask(taskID);
            slashOwner(taskID, s.currentChallenger);
            return s.currentChallenger == msg.sender;
        }
        return false;
    }

    function endChallengePeriod(bytes32 taskID) public returns (bool) {
        Task storage t = tasks[taskID];
        if (t.state != State.SolutionCommitted || !(t.timeoutBlock < block.number)) return false;
        
        t.state = State.IntentsRevealed;
        emit EndRevealPeriod(taskID);
        t.timeoutBlock = block.number + BASIC_TIMEOUT;

        return true;
    }

    // @dev – verifiers can call this until task giver changes state or timeout
    // @param taskID – the task id.
    // @param intent – submit 0 to challenge solution0, 1 to challenge solution1, anything else challenges both
    // @return – boolean
    function makeChallenge(bytes32 taskID) public payable returns (bool) {
        Task storage t = tasks[taskID];
        require(t.state == State.SolutionCommitted);
        require(msg.value == VERIFIER_DEPOSIT);
        uint position = solutions[taskID].allChallengers.length;
        solutions[taskID].allChallengers.push(msg.sender);

        emit VerificationCommitted(taskID, msg.sender, position);
        return true;
    }

    // @dev – solver reveals which solution they say is the correct one
    // 4 -> 5
    // @param taskID – the task id.
    // @param solution0Correct – determines if solution0Hash is the correct solution
    // @param originalRandomBits – original random bits for sake of commitment.
    // @return – boolean
    function revealSolution(bytes32 taskID, bytes32 codeHash, bytes32 sizeHash, bytes32 nameHash, bytes32 dataHash) public {
        Task storage t = tasks[taskID];
        require(t.state == State.IntentsRevealed);
        require(t.owner == msg.sender);

        Solution storage s = solutions[taskID];

        s.nameHash = nameHash;
        s.sizeHash = sizeHash;
        s.dataHash = dataHash;

        require(keccak256(abi.encodePacked(codeHash, sizeHash, nameHash, dataHash)) == s.solutionHash);

        t.state = State.SolutionRevealed;
        emit SolutionRevealed(taskID);
        t.timeoutBlock = block.number;
    }


    // verifier should be responsible for calling this first
    function canRunVerificationGame(bytes32 taskID) public view returns (bool) {
        Task storage t = tasks[taskID];
        Solution storage s = solutions[taskID];
        if (t.state != State.SolutionRevealed) return false;
        if (s.allChallengers.length == 0) return false;
        return (s.currentGame == 0 || IDisputeResolutionLayer(disputeResolutionLayer).status(s.currentGame) == uint(Status.SolverWon));
    }
    
    function runVerificationGame(bytes32 taskID) public {
        Task storage t = tasks[taskID];
        Solution storage s = solutions[taskID];
        
        require(t.state == State.SolutionRevealed);
        require(s.currentGame == 0 || IDisputeResolutionLayer(disputeResolutionLayer).status(s.currentGame) == uint(Status.SolverWon));

        address payable slashedVerifier = s.currentChallenger;

        if (s.allChallengers.length > 0) {
            s.currentChallenger = s.allChallengers[s.allChallengers.length-1];
            verificationGame(taskID, owner, s.currentChallenger, s.solutionHash);
            s.allChallengers.length -= 1;
        }
        // emit VerificationGame(t.selectedSolver, s.currentChallenger);
        t.timeoutBlock = block.number;
        slashVerifier(taskID, slashedVerifier);
    }

    function verificationGame(bytes32 taskID, address solver, address challenger, bytes32 solutionHash) internal {
        Task storage t = tasks[taskID];
        uint size = 1;
        uint timeout = BASIC_TIMEOUT+t.difficulty*INTERPRET_RATE+GAME_TIMEOUT;
        bytes32 gameID = IGameMaker(disputeResolutionLayer).make(taskID, solver, challenger, t.initTaskHash, solutionHash, size, timeout);
        solutions[taskID].currentGame = gameID;
    }
    
    function uploadFile(bytes32 id, uint num, bytes32 file_id,
                        bytes32[] memory name_proof, bytes32[] memory data_proof, bytes32[] memory size_proof, uint file_num) public returns (bool) {
        Task storage t = tasks[id];
        Solution storage s = solutions[id];
        RequiredFile storage file = t.uploads[num];

        require(getRoot(size_proof, file_num) == s.sizeHash);
        uint size = uint(getLeaf(size_proof, file_num));

        if (size > file.maxSize) {
            file.fileId = bytes32(uint(1));
            return true;
        }

        require(size == fs.getByteSize(file_id));
        require(checkProof(fs.getRoot(file_id), s.dataHash, data_proof, file_num));
        require(checkProof(fs.getNameHash(file_id), s.nameHash, name_proof, file_num));
        
        file.fileId = file_id;
        return true;
    }
    
    function getLeaf(bytes32[] memory proof, uint loc) internal pure returns (uint) {
        require(proof.length >= 2);
        if (loc%2 == 0) return uint(proof[0]);
        else return uint(proof[1]);
    }
    
    function getRoot(bytes32[] memory proof, uint loc) internal pure returns (bytes32) {
        require(proof.length >= 2);
        bytes32 res = keccak256(abi.encodePacked(proof[0], proof[1]));
        for (uint i = 2; i < proof.length; i++) {
            loc = loc/2;
            if (loc%2 == 0) res = keccak256(abi.encodePacked(res, proof[i]));
            else res = keccak256(abi.encodePacked(proof[i], res));
        }
        require(loc < 2); // This should be runtime error, access over bounds
        return res;
    }
    
    function checkProof(bytes32 hash, bytes32 root, bytes32[] memory proof, uint loc) internal pure returns (bool) {
        return uint(hash) == getLeaf(proof, loc) && root == getRoot(proof, loc);
    }

    function finalizeTask(bytes32 taskID) public {
        Task storage t = tasks[taskID];
        Solution storage s = solutions[taskID];

        require(t.state == State.SolutionRevealed);
        require(s.allChallengers.length == 0 && (s.currentGame == 0 || IDisputeResolutionLayer(disputeResolutionLayer).status(s.currentGame) == uint(Status.SolverWon)));

        bytes32[] memory files = new bytes32[](t.uploads.length);
        for (uint i = 0; i < t.uploads.length; i++) {
            require(t.uploads[i].fileId != 0);
            files[i] = t.uploads[i].fileId;
        }

        t.state = State.TaskFinalized;

        payReward(taskID);
        bool ok;
        bytes memory res;
        (ok, res) = t.giver.call(abi.encodeWithSignature("solved(bytes32,bytes32[])", taskID, files));
        emit TaskFinalized(taskID, ok, res, t.giver);

        if (IDisputeResolutionLayer(disputeResolutionLayer).status(s.currentGame) == uint(Status.SolverWon)) {
            slashVerifier(taskID, s.currentChallenger);
        }

    }
    
    function isFinalized(bytes32 taskID) public view returns (bool) {
        Task storage t = tasks[taskID];
        return (t.state == State.TaskFinalized);
    }
    
    function isFailed(bytes32 taskID) public view returns (bool) {
        Task storage t = tasks[taskID];
        return (t.state == State.TaskTimeout);
    }
    
    function getBlock(bytes32 taskID) public view returns (uint) {
        Task storage t = tasks[taskID];
        return t.initBlock;
    }
    
    function getSolution(bytes32 taskID) public view returns(bytes32) {
        Solution storage s = solutions[taskID];
        return s.solutionHash;
    }

    function canFinalizeTask(bytes32 taskID) public view returns (bool) {
        Task storage t = tasks[taskID];
        Solution storage s = solutions[taskID];
        
        if (t.state != State.SolutionRevealed) return false;

        if (!(s.allChallengers.length == 0 && (s.currentGame == 0 || IDisputeResolutionLayer(disputeResolutionLayer).status(s.currentGame) == uint(Status.SolverWon)))) return false;

        for (uint i = 0; i < t.uploads.length; i++) {
           if (t.uploads[i].fileId == 0) return false;
        }
        
        return true;
    }

    function getTaskInfo(bytes32 taskID) public view returns (address, bytes32, bytes32) {
        Task storage t = tasks[taskID];
        return (t.giver, t.initTaskHash, taskID);
    }

    function getSolutionInfo(bytes32 taskID) public view returns(bytes32, bytes32, bytes32, address) {
        Task storage t = tasks[taskID];
        Solution storage s = solutions[taskID];
        return (taskID, s.solutionHash, t.initTaskHash, t.giver);
    }

}
