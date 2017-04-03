pragma solidity 0.4.8;

contract SGBManager {
  
  event SGBUpdate(uint indexed sgbId, string indexed message);
  event RecordUpdate(address indexed user, uint indexed sgb_id, uint waste_amt, string indexed message);
  //representation of a SGB
  struct SGB{

  		uint sgb_id;
  		string lat;
  		string lon;
  		// for the SWM project, it should be 1 gm = 10 szabo (1 szabo = 0.000001 Ether = 0,00005 $); so 500 gm = 5000 szabo = 0.25$
  		// also floating point of weights will be rounded of to nearest integer value 503.65 grm = 504 grm
  		uint rate;   
  		uint max_capacity; //in grams, since solidity doesnt allow decimal values
  		uint current_waste_level; //in grams
  		address owner_account; // since CommunityDAO sponsers it, the address should be of communityDAO
  }

  // representation of transaction between user and sgb.
  struct Record{

  	uint record_id;
  	address user;
  	uint sgb_id;
  	uint amount_of_waste;
  	string message; // it can have two values: "REMOVED" or "ADDED". This way both waste collectors and waste bin users can be represented
  }

  //collection of all sgb
  SGB[] public sgbCollection;
  Record[] public recordCollection;

  function addSGB(string latitude, string longitude, uint rate, uint max, uint current, address owner) returns (uint id){
  	uint sgbId = sgbCollection.length++;
  	sgbCollection[sgbId] = SGB(sgbId,latitude,longitude,rate, max,current,owner);
  	SGBUpdate(sgbId,"ADDED");
  	return sgbId;
  }

  function addRecord(address user_address, uint sgb_id, uint waste, string message) returns (uint price){
  	uint recordId = recordCollection.length++;
  	recordCollection[recordId] = Record(recordId,user_address,sgb_id,waste,message);
  	RecordUpdate(user_address,sgb_id,waste,message);
  	return calculatePrice(waste, sgb_id);
  }

  function calculatePrice(uint weight, uint sgb_id) returns (uint price){

    return weight * sgbCollection[sgb_id].rate;

  }
  
}
