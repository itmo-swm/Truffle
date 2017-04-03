pragma solidity 0.4.8;

contract SGBFactory {

	event FundsReceived(address indexed sender, uint256 amt);
	mapping (address => uint256) public investmentFrom;
	address public owner;

  modifier onlyOwner{

  	if(msg.sender != owner) throw;
  	_;

  }

  function SGBFactory() {
    // constructor
    owner = msg.sender;
  }

  function() payable{

  	investmentFrom[msg.sender] += msg.value;
  	FundsReceived(msg.sender,msg.value);

  }

}
