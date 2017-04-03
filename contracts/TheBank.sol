/* 
    About this contract:

    This contract creates a Bank in Ethereum. The bank has its own cryptocurrency. Whenever users send ether to the bank's address, the anonymous
    funtion function() payable{} is called. The banks then converts the amount of ether sent to it into PercCoin using the conversion rate defined during
    the creation of the bank. This exchange rate can be changed by bank at any time.
    
    Only the account holders or the bank itself can transfer fund to other account.

    Only the bank can create new coins by calling the method mintCoin.

 */

pragma solidity 0.4.8;

contract TheBank{
    
    event ExchangeRateChanged(uint _oldRate, uint _newRate);
    event Transfer(address indexed _from, address indexed _to, uint256 _amt);
    event BankTransfer(address indexed _from, address indexed _to, uint256 _amt);
    event NewPercCoinsCreated(uint _createdAmt);
    

    string nameOfCurrency;
    string symbolForCurrency;
    mapping (address => uint256) public balanceOf;
    uint public exchangeRate;
    address public bankAddress;
    uint256 public totalSupplyOfEther;
    uint256 public totalSupplyOfPercCoin;
    
    modifier onlyBank{
        
        if(msg.sender != bankAddress) throw;
        _;
        
    }
    
    modifier onlyBankOrAccountHolder{
        if(msg.sender != bankAddress || balanceOf[msg.sender] == 0) throw;
        _;
    }
    
    /*BankOwner or exchange address is set during the formation */
    function TheBank(uint initialExchangeRate, string name, string symbol){
        exchangeRate = initialExchangeRate; //for simplicity keep it to 1 Wei = 1 PercCoin
        nameOfCurrency = name;
        symbolForCurrency = symbol;
        bankAddress = msg.sender;

    }
    
    /*If someone sends Ether to the bank, it is converted to PercCoin and stored in the bank under sender's address*/
    function() payable{
        
        balanceOf[msg.sender] += msg.value * exchangeRate;
        totalSupplyOfEther += msg.value;
        totalSupplyOfPercCoin += balanceOf[msg.sender];
    }
    
    function changeExchangeRate(uint newExchangeRate) onlyBank returns (uint newRate){
        ExchangeRateChanged(exchangeRate, newExchangeRate);
        exchangeRate = newExchangeRate;
        return newExchangeRate;
    }
    
    function transfer(address _to, uint256 _amt) onlyBankOrAccountHolder returns (bool success){
        /*check if sender has enough balance*/
        if(balanceOf[msg.sender] < _amt) throw;
        /*check if negative balance is sent*/
        if(balanceOf[_to] + _amt < 0) throw;
        
        balanceOf[msg.sender] -= _amt;
        balanceOf[_to] += _amt;
        
        /*Create an event of the transfer*/
        Transfer(msg.sender,_to,_amt);
        
        return true;
    }

    function payOnUsersBehalf(address _from, address _to, uint _amt) onlyBank returns (bool success){

        if(balanceOf[_from] < _amt) throw;
        /*check if negative balance is sent*/
        if(balanceOf[_to] + _amt < 0) throw;
        
        balanceOf[_from] -= _amt;
        balanceOf[_to] += _amt;
        
        /*Create an event of the transfer*/
        BankTransfer(_from,_to,_amt);
        
        return true;   

    }
    
    /*It creates new PercCoin and sends it to the _receiver address */
    /*Only the bank can create the new coins*/
    function mintCoin(address _receiver, uint _amt) onlyBank returns (bool success){
        totalSupplyOfPercCoin += _amt ;
        balanceOf[msg.sender] += _amt;
        NewPercCoinsCreated(_amt);

        return true;
    }
    
}