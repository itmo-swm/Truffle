var Web3 = require("web3");
var SolidityEvent = require("web3/lib/web3/event.js");

(function() {
  // Planned for future features, logging, etc.
  function Provider(provider) {
    this.provider = provider;
  }

  Provider.prototype.send = function() {
    this.provider.send.apply(this.provider, arguments);
  };

  Provider.prototype.sendAsync = function() {
    this.provider.sendAsync.apply(this.provider, arguments);
  };

  var BigNumber = (new Web3()).toBigNumber(0).constructor;

  var Utils = {
    is_object: function(val) {
      return typeof val == "object" && !Array.isArray(val);
    },
    is_big_number: function(val) {
      if (typeof val != "object") return false;

      // Instanceof won't work because we have multiple versions of Web3.
      try {
        new BigNumber(val);
        return true;
      } catch (e) {
        return false;
      }
    },
    merge: function() {
      var merged = {};
      var args = Array.prototype.slice.call(arguments);

      for (var i = 0; i < args.length; i++) {
        var object = args[i];
        var keys = Object.keys(object);
        for (var j = 0; j < keys.length; j++) {
          var key = keys[j];
          var value = object[key];
          merged[key] = value;
        }
      }

      return merged;
    },
    promisifyFunction: function(fn, C) {
      var self = this;
      return function() {
        var instance = this;

        var args = Array.prototype.slice.call(arguments);
        var tx_params = {};
        var last_arg = args[args.length - 1];

        // It's only tx_params if it's an object and not a BigNumber.
        if (Utils.is_object(last_arg) && !Utils.is_big_number(last_arg)) {
          tx_params = args.pop();
        }

        tx_params = Utils.merge(C.class_defaults, tx_params);

        return new Promise(function(accept, reject) {
          var callback = function(error, result) {
            if (error != null) {
              reject(error);
            } else {
              accept(result);
            }
          };
          args.push(tx_params, callback);
          fn.apply(instance.contract, args);
        });
      };
    },
    synchronizeFunction: function(fn, instance, C) {
      var self = this;
      return function() {
        var args = Array.prototype.slice.call(arguments);
        var tx_params = {};
        var last_arg = args[args.length - 1];

        // It's only tx_params if it's an object and not a BigNumber.
        if (Utils.is_object(last_arg) && !Utils.is_big_number(last_arg)) {
          tx_params = args.pop();
        }

        tx_params = Utils.merge(C.class_defaults, tx_params);

        return new Promise(function(accept, reject) {

          var decodeLogs = function(logs) {
            return logs.map(function(log) {
              var logABI = C.events[log.topics[0]];

              if (logABI == null) {
                return null;
              }

              var decoder = new SolidityEvent(null, logABI, instance.address);
              return decoder.decode(log);
            }).filter(function(log) {
              return log != null;
            });
          };

          var callback = function(error, tx) {
            if (error != null) {
              reject(error);
              return;
            }

            var timeout = C.synchronization_timeout || 240000;
            var start = new Date().getTime();

            var make_attempt = function() {
              C.web3.eth.getTransactionReceipt(tx, function(err, receipt) {
                if (err) return reject(err);

                if (receipt != null) {
                  // If they've opted into next gen, return more information.
                  if (C.next_gen == true) {
                    return accept({
                      tx: tx,
                      receipt: receipt,
                      logs: decodeLogs(receipt.logs)
                    });
                  } else {
                    return accept(tx);
                  }
                }

                if (timeout > 0 && new Date().getTime() - start > timeout) {
                  return reject(new Error("Transaction " + tx + " wasn't processed in " + (timeout / 1000) + " seconds!"));
                }

                setTimeout(make_attempt, 1000);
              });
            };

            make_attempt();
          };

          args.push(tx_params, callback);
          fn.apply(self, args);
        });
      };
    }
  };

  function instantiate(instance, contract) {
    instance.contract = contract;
    var constructor = instance.constructor;

    // Provision our functions.
    for (var i = 0; i < instance.abi.length; i++) {
      var item = instance.abi[i];
      if (item.type == "function") {
        if (item.constant == true) {
          instance[item.name] = Utils.promisifyFunction(contract[item.name], constructor);
        } else {
          instance[item.name] = Utils.synchronizeFunction(contract[item.name], instance, constructor);
        }

        instance[item.name].call = Utils.promisifyFunction(contract[item.name].call, constructor);
        instance[item.name].sendTransaction = Utils.promisifyFunction(contract[item.name].sendTransaction, constructor);
        instance[item.name].request = contract[item.name].request;
        instance[item.name].estimateGas = Utils.promisifyFunction(contract[item.name].estimateGas, constructor);
      }

      if (item.type == "event") {
        instance[item.name] = contract[item.name];
      }
    }

    instance.allEvents = contract.allEvents;
    instance.address = contract.address;
    instance.transactionHash = contract.transactionHash;
  };

  // Use inheritance to create a clone of this contract,
  // and copy over contract's static functions.
  function mutate(fn) {
    var temp = function Clone() { return fn.apply(this, arguments); };

    Object.keys(fn).forEach(function(key) {
      temp[key] = fn[key];
    });

    temp.prototype = Object.create(fn.prototype);
    bootstrap(temp);
    return temp;
  };

  function bootstrap(fn) {
    fn.web3 = new Web3();
    fn.class_defaults  = fn.prototype.defaults || {};

    // Set the network iniitally to make default data available and re-use code.
    // Then remove the saved network id so the network will be auto-detected on first use.
    fn.setNetwork("default");
    fn.network_id = null;
    return fn;
  };

  // Accepts a contract object created with web3.eth.contract.
  // Optionally, if called without `new`, accepts a network_id and will
  // create a new version of the contract abstraction with that network_id set.
  function Contract() {
    if (this instanceof Contract) {
      instantiate(this, arguments[0]);
    } else {
      var C = mutate(Contract);
      var network_id = arguments.length > 0 ? arguments[0] : "default";
      C.setNetwork(network_id);
      return C;
    }
  };

  Contract.currentProvider = null;

  Contract.setProvider = function(provider) {
    var wrapped = new Provider(provider);
    this.web3.setProvider(wrapped);
    this.currentProvider = provider;
  };

  Contract.new = function() {
    if (this.currentProvider == null) {
      throw new Error("ComDAO error: Please call setProvider() first before calling new().");
    }

    var args = Array.prototype.slice.call(arguments);

    if (!this.unlinked_binary) {
      throw new Error("ComDAO error: contract binary not set. Can't deploy new instance.");
    }

    var regex = /__[^_]+_+/g;
    var unlinked_libraries = this.binary.match(regex);

    if (unlinked_libraries != null) {
      unlinked_libraries = unlinked_libraries.map(function(name) {
        // Remove underscores
        return name.replace(/_/g, "");
      }).sort().filter(function(name, index, arr) {
        // Remove duplicates
        if (index + 1 >= arr.length) {
          return true;
        }

        return name != arr[index + 1];
      }).join(", ");

      throw new Error("ComDAO contains unresolved libraries. You must deploy and link the following libraries before you can deploy a new version of ComDAO: " + unlinked_libraries);
    }

    var self = this;

    return new Promise(function(accept, reject) {
      var contract_class = self.web3.eth.contract(self.abi);
      var tx_params = {};
      var last_arg = args[args.length - 1];

      // It's only tx_params if it's an object and not a BigNumber.
      if (Utils.is_object(last_arg) && !Utils.is_big_number(last_arg)) {
        tx_params = args.pop();
      }

      tx_params = Utils.merge(self.class_defaults, tx_params);

      if (tx_params.data == null) {
        tx_params.data = self.binary;
      }

      // web3 0.9.0 and above calls new twice this callback twice.
      // Why, I have no idea...
      var intermediary = function(err, web3_instance) {
        if (err != null) {
          reject(err);
          return;
        }

        if (err == null && web3_instance != null && web3_instance.address != null) {
          accept(new self(web3_instance));
        }
      };

      args.push(tx_params, intermediary);
      contract_class.new.apply(contract_class, args);
    });
  };

  Contract.at = function(address) {
    if (address == null || typeof address != "string" || address.length != 42) {
      throw new Error("Invalid address passed to ComDAO.at(): " + address);
    }

    var contract_class = this.web3.eth.contract(this.abi);
    var contract = contract_class.at(address);

    return new this(contract);
  };

  Contract.deployed = function() {
    if (!this.address) {
      throw new Error("Cannot find deployed address: ComDAO not deployed or address not set.");
    }

    return this.at(this.address);
  };

  Contract.defaults = function(class_defaults) {
    if (this.class_defaults == null) {
      this.class_defaults = {};
    }

    if (class_defaults == null) {
      class_defaults = {};
    }

    var self = this;
    Object.keys(class_defaults).forEach(function(key) {
      var value = class_defaults[key];
      self.class_defaults[key] = value;
    });

    return this.class_defaults;
  };

  Contract.extend = function() {
    var args = Array.prototype.slice.call(arguments);

    for (var i = 0; i < arguments.length; i++) {
      var object = arguments[i];
      var keys = Object.keys(object);
      for (var j = 0; j < keys.length; j++) {
        var key = keys[j];
        var value = object[key];
        this.prototype[key] = value;
      }
    }
  };

  Contract.all_networks = {
  "default": {
    "abi": [
      {
        "constant": true,
        "inputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "name": "proposals",
        "outputs": [
          {
            "name": "recipient",
            "type": "address"
          },
          {
            "name": "amount",
            "type": "uint256"
          },
          {
            "name": "description",
            "type": "string"
          },
          {
            "name": "votingDeadline",
            "type": "uint256"
          },
          {
            "name": "executed",
            "type": "bool"
          },
          {
            "name": "proposalPassed",
            "type": "bool"
          },
          {
            "name": "numberOfVotes",
            "type": "uint256"
          },
          {
            "name": "currentResult",
            "type": "int256"
          },
          {
            "name": "proposalHash",
            "type": "bytes32"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "targetMember",
            "type": "address"
          }
        ],
        "name": "removeMember",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "proposalNumber",
            "type": "uint256"
          },
          {
            "name": "transactionBytecode",
            "type": "bytes"
          }
        ],
        "name": "executeProposal",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "name": "sgbCollection",
        "outputs": [
          {
            "name": "sgb_id",
            "type": "uint256"
          },
          {
            "name": "lat",
            "type": "string"
          },
          {
            "name": "lon",
            "type": "string"
          },
          {
            "name": "rate",
            "type": "uint256"
          },
          {
            "name": "max_capacity",
            "type": "uint256"
          },
          {
            "name": "current_waste_level",
            "type": "uint256"
          },
          {
            "name": "owner_account",
            "type": "address"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "name": "memberId",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "name": "recordCollection",
        "outputs": [
          {
            "name": "record_id",
            "type": "uint256"
          },
          {
            "name": "user",
            "type": "address"
          },
          {
            "name": "sgb_id",
            "type": "uint256"
          },
          {
            "name": "amount_of_waste",
            "type": "uint256"
          },
          {
            "name": "message",
            "type": "string"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "numProposals",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "name": "members",
        "outputs": [
          {
            "name": "member",
            "type": "address"
          },
          {
            "name": "name",
            "type": "string"
          },
          {
            "name": "memberSince",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "latitude",
            "type": "string"
          },
          {
            "name": "longitude",
            "type": "string"
          },
          {
            "name": "rate",
            "type": "uint256"
          },
          {
            "name": "max",
            "type": "uint256"
          },
          {
            "name": "current",
            "type": "uint256"
          },
          {
            "name": "owner",
            "type": "address"
          }
        ],
        "name": "addSGB",
        "outputs": [
          {
            "name": "id",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "debatingPeriodInMinutes",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "minimumQuorum",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "owner",
        "outputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_from",
            "type": "address"
          },
          {
            "name": "_value",
            "type": "uint256"
          },
          {
            "name": "_token",
            "type": "address"
          },
          {
            "name": "_extraData",
            "type": "bytes"
          }
        ],
        "name": "receiveApproval",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "weight",
            "type": "uint256"
          },
          {
            "name": "sgb_id",
            "type": "uint256"
          }
        ],
        "name": "calculatePrice",
        "outputs": [
          {
            "name": "price",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "majorityMargin",
        "outputs": [
          {
            "name": "",
            "type": "int256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "beneficiary",
            "type": "address"
          },
          {
            "name": "etherAmount",
            "type": "uint256"
          },
          {
            "name": "JobDescription",
            "type": "string"
          },
          {
            "name": "transactionBytecode",
            "type": "bytes"
          }
        ],
        "name": "newProposal",
        "outputs": [
          {
            "name": "proposalID",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "user_address",
            "type": "address"
          },
          {
            "name": "sgb_id",
            "type": "uint256"
          },
          {
            "name": "waste",
            "type": "uint256"
          },
          {
            "name": "message",
            "type": "string"
          }
        ],
        "name": "addRecord",
        "outputs": [
          {
            "name": "price",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "minimumQuorumForProposals",
            "type": "uint256"
          },
          {
            "name": "minutesForDebate",
            "type": "uint256"
          },
          {
            "name": "marginOfVotesForMajority",
            "type": "int256"
          }
        ],
        "name": "changeVotingRules",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "targetMember",
            "type": "address"
          },
          {
            "name": "memberName",
            "type": "string"
          }
        ],
        "name": "addMember",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "proposalNumber",
            "type": "uint256"
          },
          {
            "name": "supportsProposal",
            "type": "bool"
          },
          {
            "name": "justificationText",
            "type": "string"
          }
        ],
        "name": "vote",
        "outputs": [
          {
            "name": "voteID",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "proposalNumber",
            "type": "uint256"
          },
          {
            "name": "beneficiary",
            "type": "address"
          },
          {
            "name": "etherAmount",
            "type": "uint256"
          },
          {
            "name": "transactionBytecode",
            "type": "bytes"
          }
        ],
        "name": "checkProposalCode",
        "outputs": [
          {
            "name": "codeChecksOut",
            "type": "bool"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "newOwner",
            "type": "address"
          }
        ],
        "name": "transferOwnership",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "inputs": [
          {
            "name": "minimumQuorumForProposals",
            "type": "uint256"
          },
          {
            "name": "minutesForDebate",
            "type": "uint256"
          },
          {
            "name": "marginOfVotesForMajority",
            "type": "int256"
          },
          {
            "name": "congressLeader",
            "type": "address"
          }
        ],
        "payable": true,
        "type": "constructor"
      },
      {
        "payable": true,
        "type": "fallback"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "proposalID",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "recipient",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "amount",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "description",
            "type": "string"
          }
        ],
        "name": "ProposalAdded",
        "type": "event"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "proposalID",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "position",
            "type": "bool"
          },
          {
            "indexed": false,
            "name": "voter",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "justification",
            "type": "string"
          }
        ],
        "name": "Voted",
        "type": "event"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "proposalID",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "result",
            "type": "int256"
          },
          {
            "indexed": false,
            "name": "quorum",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "active",
            "type": "bool"
          }
        ],
        "name": "ProposalTallied",
        "type": "event"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "member",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "isMember",
            "type": "bool"
          }
        ],
        "name": "MembershipChanged",
        "type": "event"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "minimumQuorum",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "debatingPeriodInMinutes",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "majorityMargin",
            "type": "int256"
          }
        ],
        "name": "ChangeOfRules",
        "type": "event"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "sgbId",
            "type": "uint256"
          },
          {
            "indexed": true,
            "name": "message",
            "type": "string"
          }
        ],
        "name": "SGBUpdate",
        "type": "event"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "user",
            "type": "address"
          },
          {
            "indexed": true,
            "name": "sgb_id",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "waste_amt",
            "type": "uint256"
          },
          {
            "indexed": true,
            "name": "message",
            "type": "string"
          }
        ],
        "name": "RecordUpdate",
        "type": "event"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "sender",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "amount",
            "type": "uint256"
          }
        ],
        "name": "receivedEther",
        "type": "event"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "_from",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "_value",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "_token",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "_extraData",
            "type": "bytes"
          }
        ],
        "name": "receivedTokens",
        "type": "event"
      }
    ],
    "unlinked_binary": "0x60606040526040516080806200278183398101604090815281516020830151918301516060909301519092905b5b60008054600160a060020a03191633600160a060020a03161790555b6200006484848464010000000062001cea6200011e82021704565b600160a060020a03811615620000905760008054600160a060020a031916600160a060020a0383161790555b60408051602081019091526000808252620000b99164010000000062001d5b6200019182021704565b60005460408051808201909152600781527f666f756e6465720000000000000000000000000000000000000000000000000060208201526200011391600160a060020a03169064010000000062001d5b6200019182021704565b5b5050505062000477565b60005433600160a060020a039081169116146200013b5762000000565b600383905560048290556005819055604080518481526020810184905280820183905290517fa439d3fa452be5e0e1e24a8145e715f4fd8b9c08c96a42fd82a855a85e5d57de9181900360600190a15b5b505050565b60008054819033600160a060020a03908116911614620001b15762000000565b600160a060020a0384166000908152600860205260409020541515620003eb5760098054600160a060020a038616600090815260086020526040902081905560018101808355909190828015829011620002b757600302816003028360005260206000209182019101620002b791905b808211156200029c578054600160a060020a031916815560018082018054600080835592600260001991831615610100029190910190911604601f8190106200026b5750620002a0565b601f016020900490600052602060002090810190620002a091905b808211156200029c576000815560010162000286565b5090565b5b50506000600282015560030162000221565b5090565b5b505050915060606040519081016040528085600160a060020a031681526020018481526020014281525060098381548110156200000057906000526020600020906003020160005b5060008201518160000160006101000a815481600160a060020a030219169083600160a060020a031602179055506020820151816001019080519060200190828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f106200038257805160ff1916838001178555620003b2565b82800160010185558215620003b2579182015b82811115620003b257825182559160200191906001019062000395565b5b50620003d69291505b808211156200029c576000815560010162000286565b5090565b5050604082015181600201559050506200042b565b600160a060020a038416600090815260086020526040902054600980549193509083908110156200000057906000526020600020906003020160005b5090505b60408051600160a060020a03861681526001602082015281517f27b022af4a8347100c7a041ce5ccf8e14d644ff05de696315196faae8cd50c9b929181900390910190a15b5b50505050565b6122fa80620004876000396000f3006060604052361561010c5763ffffffff60e060020a600035041663013cf08b81146101585780630b1ca49a1461023f578063237e94921461025a578063259e1fa5146102b057806339106821146103f6578063396dbe5c14610421578063400e3949146104e05780635daf08ca146104ff5780636954d2ba146105af57806369bd34361461066d5780638160f0b51461068c5780638da5cb5b146106ab5780638f4ffcb1146106d4578063a6413a271461073f578063aa02a90f14610764578063b1050da514610783578063b1a842c314610832578063bcca1fd3146108a6578063c127c247146108be578063d3c0715b1461091d578063eceb294514610988578063f2fde38b146109fe575b6101565b60408051600160a060020a033316815234602082015281517fa398b89ba344a0b23a0b9de53db298b2a1a868b396c1878b7e9dcbafecd49b13929181900390910190a15b565b005b3461000057610168600435610a19565b60408051600160a060020a038b168152602081018a905260608101889052861515608082015285151560a082015260c0810185905260e081018490526101008082018490526101209282018381528a546002600182161590930260001901169190910492820183905290916101408301908a9080156102285780601f106101fd57610100808354040283529160200191610228565b820191906000526020600020905b81548152906001019060200180831161020b57829003601f168201915b50509a505050505050505050505060405180910390f35b3461000057610156600160a060020a0360043516610a7d565b005b346100005760408051602060046024803582810135601f81018590048502860185019096528585526101569583359593946044949392909201918190840183828082843750949650610d7b95505050505050565b005b34610000576102c0600435610fb4565b60408051888152606081018690526080810185905260a08101849052600160a060020a03831660c082015260e06020820181815289546002600182161561010090810260001901909216049284018390529293909290840191908401908a90801561036c5780601f106103415761010080835404028352916020019161036c565b820191906000526020600020905b81548152906001019060200180831161034f57829003601f168201915b50508381038252885460026000196101006001841615020190911604808252602090910190899080156103e05780601f106103b5576101008083540402835291602001916103e0565b820191906000526020600020905b8154815290600101906020018083116103c357829003601f168201915b5050995050505050505050505060405180910390f35b346100005761040f600160a060020a0360043516611000565b60408051918252519081900360200190f35b3461000057610431600435611012565b60408051868152600160a060020a03861660208201529081018490526060810183905260a0608082018181528354600260001961010060018416150201909116049183018290529060c0830190849080156104cd5780601f106104a2576101008083540402835291602001916104cd565b820191906000526020600020905b8154815290600101906020018083116104b057829003601f168201915b5050965050505050505060405180910390f35b346100005761040f611059565b60408051918252519081900360200190f35b346100005761050f60043561105f565b60408051600160a060020a03851681529081018290526060602082018181528454600260001961010060018416150201909116049183018290529060808301908590801561059e5780601f106105735761010080835404028352916020019161059e565b820191906000526020600020905b81548152906001019060200180831161058157829003601f168201915b505094505050505060405180910390f35b346100005761040f600480803590602001908201803590602001908080601f0160208091040260200160405190810160405280939291908181526020018383808284375050604080516020601f89358b0180359182018390048302840183019094528083529799988101979196509182019450925082915084018382808284375094965050843594602081013594506040810135935060600135600160a060020a0316915061109a9050565b60408051918252519081900360200190f35b346100005761040f611433565b60408051918252519081900360200190f35b346100005761040f611439565b60408051918252519081900360200190f35b34610000576106b861143f565b60408051600160a060020a039092168252519081900360200190f35b3461000057604080516020600460643581810135601f8101849004840285018401909552848452610156948235600160a060020a039081169560248035966044359093169594608494929391019190819084018382808284375094965061144e95505050505050565b005b346100005761040f6004356024356115cc565b60408051918252519081900360200190f35b346100005761040f6115fb565b60408051918252519081900360200190f35b3461000057604080516020600460443581810135601f810184900484028501840190955284845261040f948235600160a060020a031694602480359560649492939190920191819084018382808284375050604080516020601f89358b0180359182018390048302840183019094528083529799988101979196509182019450925082915084018382808284375094965061160195505050505050565b60408051918252519081900360200190f35b3461000057604080516020600460643581810135601f810184900484028501840190955284845261040f948235600160a060020a03169460248035956044359594608494920191908190840183828082843750949650611a2b95505050505050565b60408051918252519081900360200190f35b3461000057610156600435602435604435611cea565b005b346100005760408051602060046024803582810135601f8101859004850286018501909652858552610156958335600160a060020a03169593946044949392909201918190840183828082843750949650611d5b95505050505050565b005b3461000057604080516020600460443581810135601f810184900484028501840190955284845261040f948235946024803515159560649492939190920191819084018382808284375094965061202a95505050505050565b60408051918252519081900360200190f35b3461000057604080516020600460643581810135601f81018490048402850184019095528484526109ea9482359460248035600160a060020a03169560443595946084949201919081908401838280828437509496506121d995505050505050565b604080519115158252519081900360200190f35b3461000057610156600160a060020a0360043516612293565b005b60068181548110156100005790600052602060002090600a020160005b508054600182015460038301546004840154600585015460068601546007870154600160a060020a039096169750939560020194929360ff80841694610100909404169289565b6000805433600160a060020a03908116911614610a9957610000565b600160a060020a0382166000908152600860205260409020541515610abd57610000565b50600160a060020a0381166000908152600860205260409020545b60095460001901811015610c0f57600981600101815481101561000057906000526020600020906003020160005b50600982815481101561000057906000526020600020906003020160005b5081548154600160a060020a031916600160a060020a0390911617815560018083018054838301805460008281526020908190209295601f6002848316156101009081026000199081019096168290048301949094048601979287161590930293909301909416049290839010610b9e5780548555610bda565b82800160010185558215610bda57600052602060002091601f016020900482015b82811115610bda578254825591600101919060010190610bbf565b5b50610bfb9291505b80821115610bf75760008155600101610be3565b5090565b50506002918201549101555b600101610ad8565b6009805460001981019081101561000057906000526020600020906003020160005b8154600160a060020a031916825560018083018054600082559091600260001991831615610100029190910190911604601f819010610c705750610ca2565b601f016020900490600052602060002090810190610ca291905b80821115610bf75760008155600101610be3565b5090565b5b50600282016000905550506009805480919060019003815481835581811511610d7057600302816003028360005260206000209182019101610d7091905b80821115610bf7578054600160a060020a031916815560018082018054600080835592600260001991831615610100029190910190911604601f819010610d285750610d5a565b601f016020900490600052602060002090810190610d5a91905b80821115610bf75760008155600101610be3565b5090565b5b505060006002820155600301610ce1565b5090565b5b505050505b5b5050565b600060068381548110156100005790600052602060002090600a020160005b5090508060030154421080610db35750600481015460ff165b80610e48575080546001820154604051606060020a600160a060020a039093169283028152601481018290528451859190603482019060208401908083835b60208310610e115780518252601f199092019160209182019101610df2565b5181516020939093036101000a60001901801990911692169190911790526040519201829003909120600787015414159450505050505b80610e5857506003548160050154105b15610e6257610000565b60055481600601541315610f405760048101805460ff191660019081179091558154908201546040518451600160a060020a0390931692670de0b6b3a764000090920291859190819060208401908083838215610eda575b805182526020831115610eda57601f199092019160209182019101610eba565b505050905090810190601f168015610f065780820380516001836020036101000a031916815260200191505b5091505060006040518083038185876185025a03f1925050501515610f2a57610000565b60048101805461ff001916610100179055610f4e565b60048101805461ff00191690555b6006810154600582015460048301546040805187815260208101949094528381019290925260ff6101009091041615156060830152517fd220b7272a8b6d0d7d6bcdace67b936a8f175e6d5c1b3ee438b72256b32ab3af9181900360800190a15b505050565b600181815481101561000057906000526020600020906007020160005b5080546003820154600483015460058401546006850154939550600185019460020193600160a060020a031687565b60086020526000908152604090205481565b600281815481101561000057906000526020600020906005020160005b508054600182015460028301546003840154929450600160a060020a039091169290919060040185565b60075481565b600981815481101561000057906000526020600020906003020160005b5080546002820154600160a060020a03909116925060019091019083565b60006000600180548091906001018154818355818115116111d0576007028160070283600052602060002091820191016111d091905b80821115610bf7576000600082016000905560018201805460018160011615610100020316600290046000825580601f1061110b575061113d565b601f01602090049060005260206000209081019061113d91905b80821115610bf75760008155600101610be3565b5090565b5b5060028201805460018160011615610100020316600290046000825580601f10611168575061119a565b601f01602090049060005260206000209081019061119a91905b80821115610bf75760008155600101610be3565b5090565b5b5050600060038201819055600482018190556005820155600681018054600160a060020a03191690556007016110d0565b5090565b5b505050905060e06040519081016040528082815260200189815260200188815260200187815260200186815260200185815260200184600160a060020a0316815250600182815481101561000057906000526020600020906007020160005b50600082015181600001556020820151816001019080519060200190828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f1061128d57805160ff19168380011785556112ba565b828001600101855582156112ba579182015b828111156112ba57825182559160200191906001019061129f565b5b506112db9291505b80821115610bf75760008155600101610be3565b5090565b50506040820151816002019080519060200190828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f1061132f57805160ff191683800117855561135c565b8280016001018555821561135c579182015b8281111561135c578251825591602001919060010190611341565b5b5061137d9291505b80821115610bf75760008155600101610be3565b5090565b5050606082015160038201556080820151600482015560a082015160058083019190915560c09092015160069091018054600160a060020a031916600160a060020a03909216919091179055604080517f4144444544000000000000000000000000000000000000000000000000000000815290519081900390910181209082907f5612519f74fc0cb539f45097dbb05ddda76697851b926dd5007579f3313d588a90600090a38091505b509695505050505050565b60045481565b60035481565b600054600160a060020a031681565b604080516000602091820181905282517f23b872dd000000000000000000000000000000000000000000000000000000008152600160a060020a038881166004830152308116602483015260448201889052935186948516936323b872dd936064808501949293928390030190829087803b156100005760325a03f11561000057505060405151151590506114e257610000565b7f0eeb71b8926d7ed8f47a2cedf6b9b204e2001344c7fa20c696c9f06ea7c413c6858585856040518085600160a060020a0316600160a060020a0316815260200184815260200183600160a060020a0316600160a060020a0316815260200180602001828103825283818151815260200191508051906020019080838360008314611588575b80518252602083111561158857601f199092019160209182019101611568565b505050905090810190601f1680156115b45780820380516001836020036101000a031916815260200191505b509550505050505060405180910390a15b5050505050565b6000600182815481101561000057906000526020600020906007020160005b5060030154830290505b92915050565b60055481565b600160a060020a0333166000908152600860205260408120548190151561162757610000565b600680548091906001018154818355818115116117c157600a0281600a0283600052602060002091820191016117c191905b80821115610bf7578054600160a060020a03191681556000600180830182905560028084018054848255909281161561010002600019011604601f8190106116a157506116d3565b601f0160209004906000526020600020908101906116d391905b80821115610bf75760008155600101610be3565b5090565b5b5060006003830181905560048301805461ffff1916905560058301819055600683018190556007830181905560088301805482825590825260209091206117b2916002028101905b80821115610bf757805474ffffffffffffffffffffffffffffffffffffffffff1916815560018082018054600080835592600260001991831615610100029190910190911604601f81901061177157506117a3565b601f0160209004906000526020600020908101906117a391905b80821115610bf75760008155600101610be3565b5090565b5b505060020161171c565b5090565b5b5050600a01611659565b5090565b5b505050915060068281548110156100005790600052602060002090600a020160005b508054600160a060020a038816600160a060020a0319909116178155600180820187905585516002808401805460008281526020908190209697509195601f9582161561010002600019019091169290920484018190048201939089019083901061185a57805160ff1916838001178555611887565b82800160010185558215611887579182015b8281111561188757825182559160200191906001019061186c565b5b506118a89291505b80821115610bf75760008155600101610be3565b5090565b50508585846040518084600160a060020a0316600160a060020a0316606060020a02815260140183815260200182805190602001908083835b602083106119005780518252601f1990920191602091820191016118e1565b51815160209384036101000a60001901801990921691161790526040805192909401829003822060078a015560048054603c02420160038b01558901805461ffff19169055600060058a0155898252600160a060020a038e16828201529281018c90526080606082018181528c51918301919091528b517f646fec02522b41e7125cfc859a64fd4f4cefd5dc3b6237ca0abe251ded1fa88198508a97508e96508d95508c94929350909160a08401919085019080838382156119dd575b8051825260208311156119dd57601f1990920191602091820191016119bd565b505050905090810190601f168015611a095780820380516001836020036101000a031916815260200191505b509550505050505060405180910390a1600182016007555b5b50949350505050565b6000600060028054809190600101815481835581811511611af857600502816005028360005260206000209182019101611af891905b80821115610bf757600080825560018083018054600160a060020a0319169055600280840183905560038401839055600484018054848255909281161561010002600019011604601f819010611ab75750611ae9565b601f016020900490600052602060002090810190611ae991905b80821115610bf75760008155600101610be3565b5090565b5b5050600501611a61565b5090565b5b505050905060a06040519081016040528082815260200187600160a060020a0316815260200186815260200185815260200184815250600282815481101561000057906000526020600020906005020160005b506000820151816000015560208201518160010160006101000a815481600160a060020a030219169083600160a060020a0316021790555060408201518160020155606082015181600301556080820151816004019080519060200190828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f10611bea57805160ff1916838001178555611c17565b82800160010185558215611c17579182015b82811115611c17578251825591602001919060010190611bfc565b5b50611c389291505b80821115610bf75760008155600101610be3565b5090565b5050905050826040518082805190602001908083835b60208310611c6d5780518252601f199092019160209182019101611c4e565b51815160209384036101000a6000190180199092169116179052604080519290940182900382208a835293519395508a9450600160a060020a038c16937f792a00dadd1ba2b436e7c812ef8b79defe41dd8b79691a04164e2f751915a4b49350918290030190a4611cde84866115cc565b91505b50949350505050565b60005433600160a060020a03908116911614611d0557610000565b600383905560048290556005819055604080518481526020810184905280820183905290517fa439d3fa452be5e0e1e24a8145e715f4fd8b9c08c96a42fd82a855a85e5d57de9181900360600190a15b5b505050565b60008054819033600160a060020a03908116911614611d7957610000565b600160a060020a0384166000908152600860205260409020541515611f9f5760098054600160a060020a038616600090815260086020526040902081905560018101808355909190828015829011611e7557600302816003028360005260206000209182019101611e7591905b80821115610bf7578054600160a060020a031916815560018082018054600080835592600260001991831615610100029190910190911604601f819010611e2d5750611e5f565b601f016020900490600052602060002090810190611e5f91905b80821115610bf75760008155600101610be3565b5090565b5b505060006002820155600301611de6565b5090565b5b505050915060606040519081016040528085600160a060020a0316815260200184815260200142815250600983815481101561000057906000526020600020906003020160005b5060008201518160000160006101000a815481600160a060020a030219169083600160a060020a031602179055506020820151816001019080519060200190828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f10611f3d57805160ff1916838001178555611f6a565b82800160010185558215611f6a579182015b82811115611f6a578251825591602001919060010190611f4f565b5b50611f8b9291505b80821115610bf75760008155600101610be3565b5090565b505060408201518160020155905050611fde565b600160a060020a0384166000908152600860205260409020546009805491935090839081101561000057906000526020600020906003020160005b5090505b60408051600160a060020a03861681526001602082015281517f27b022af4a8347100c7a041ce5ccf8e14d644ff05de696315196faae8cd50c9b929181900390910190a15b5b50505050565b600160a060020a0333166000908152600860205260408120548190151561205057610000565b60068581548110156100005790600052602060002090600a020160005b50600160a060020a033316600090815260098201602052604090205490915060ff1615156001141561209e57610000565b600160a060020a03331660009081526009820160205260409020805460ff19166001908117909155600582018054909101905583156120e75760068101805460010190556120f4565b6006810180546000190190555b7fc34f869b7ff431b034b7b9aea9822dac189a685e0b015c7d1be3add3f89128e885853386604051808581526020018415151515815260200183600160a060020a0316600160a060020a031681526020018060200182810382528381815181526020019150805190602001908083836000831461218c575b80518252602083111561218c57601f19909201916020918201910161216c565b505050905090810190601f1680156121b85780820380516001836020036101000a031916815260200191505b509550505050505060405180910390a1806005015491505b5b509392505050565b6000600060068681548110156100005790600052602060002090600a020160005b5090508484846040518084600160a060020a0316600160a060020a0316606060020a02815260140183815260200182805190602001908083835b602083106122535780518252601f199092019160209182019101612234565b5181516020939093036101000a60001901801990911692169190911790526040519201829003909120600787015414965050505050505b50949350505050565b60005433600160a060020a039081169116146122ae57610000565b60008054600160a060020a031916600160a060020a0383161790555b5b505600a165627a7a72305820586fcacc806972f4931f5ed79fdca127a4af7966e0b9714a2fb3341427c712760029",
    "events": {
      "0x646fec02522b41e7125cfc859a64fd4f4cefd5dc3b6237ca0abe251ded1fa881": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "proposalID",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "recipient",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "amount",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "description",
            "type": "string"
          }
        ],
        "name": "ProposalAdded",
        "type": "event"
      },
      "0xc34f869b7ff431b034b7b9aea9822dac189a685e0b015c7d1be3add3f89128e8": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "proposalID",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "position",
            "type": "bool"
          },
          {
            "indexed": false,
            "name": "voter",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "justification",
            "type": "string"
          }
        ],
        "name": "Voted",
        "type": "event"
      },
      "0xd220b7272a8b6d0d7d6bcdace67b936a8f175e6d5c1b3ee438b72256b32ab3af": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "proposalID",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "result",
            "type": "int256"
          },
          {
            "indexed": false,
            "name": "quorum",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "active",
            "type": "bool"
          }
        ],
        "name": "ProposalTallied",
        "type": "event"
      },
      "0x27b022af4a8347100c7a041ce5ccf8e14d644ff05de696315196faae8cd50c9b": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "member",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "isMember",
            "type": "bool"
          }
        ],
        "name": "MembershipChanged",
        "type": "event"
      },
      "0xa439d3fa452be5e0e1e24a8145e715f4fd8b9c08c96a42fd82a855a85e5d57de": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "minimumQuorum",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "debatingPeriodInMinutes",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "majorityMargin",
            "type": "int256"
          }
        ],
        "name": "ChangeOfRules",
        "type": "event"
      },
      "0x5612519f74fc0cb539f45097dbb05ddda76697851b926dd5007579f3313d588a": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "sgbId",
            "type": "uint256"
          },
          {
            "indexed": true,
            "name": "message",
            "type": "string"
          }
        ],
        "name": "SGBUpdate",
        "type": "event"
      },
      "0x792a00dadd1ba2b436e7c812ef8b79defe41dd8b79691a04164e2f751915a4b4": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "user",
            "type": "address"
          },
          {
            "indexed": true,
            "name": "sgb_id",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "waste_amt",
            "type": "uint256"
          },
          {
            "indexed": true,
            "name": "message",
            "type": "string"
          }
        ],
        "name": "RecordUpdate",
        "type": "event"
      },
      "0xa398b89ba344a0b23a0b9de53db298b2a1a868b396c1878b7e9dcbafecd49b13": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "sender",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "amount",
            "type": "uint256"
          }
        ],
        "name": "receivedEther",
        "type": "event"
      },
      "0x0eeb71b8926d7ed8f47a2cedf6b9b204e2001344c7fa20c696c9f06ea7c413c6": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "_from",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "_value",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "_token",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "_extraData",
            "type": "bytes"
          }
        ],
        "name": "receivedTokens",
        "type": "event"
      }
    },
    "updated_at": 1491130333771,
    "address": "0xb7fe5d01d33b6405904edde2b58687fae11b664f",
    "links": {}
  }
};

  Contract.checkNetwork = function(callback) {
    var self = this;

    if (this.network_id != null) {
      return callback();
    }

    this.web3.version.network(function(err, result) {
      if (err) return callback(err);

      var network_id = result.toString();

      // If we have the main network,
      if (network_id == "1") {
        var possible_ids = ["1", "live", "default"];

        for (var i = 0; i < possible_ids.length; i++) {
          var id = possible_ids[i];
          if (Contract.all_networks[id] != null) {
            network_id = id;
            break;
          }
        }
      }

      if (self.all_networks[network_id] == null) {
        return callback(new Error(self.name + " error: Can't find artifacts for network id '" + network_id + "'"));
      }

      self.setNetwork(network_id);
      callback();
    })
  };

  Contract.setNetwork = function(network_id) {
    var network = this.all_networks[network_id] || {};

    this.abi             = this.prototype.abi             = network.abi;
    this.unlinked_binary = this.prototype.unlinked_binary = network.unlinked_binary;
    this.address         = this.prototype.address         = network.address;
    this.updated_at      = this.prototype.updated_at      = network.updated_at;
    this.links           = this.prototype.links           = network.links || {};
    this.events          = this.prototype.events          = network.events || {};

    this.network_id = network_id;
  };

  Contract.networks = function() {
    return Object.keys(this.all_networks);
  };

  Contract.link = function(name, address) {
    if (typeof name == "function") {
      var contract = name;

      if (contract.address == null) {
        throw new Error("Cannot link contract without an address.");
      }

      Contract.link(contract.contract_name, contract.address);

      // Merge events so this contract knows about library's events
      Object.keys(contract.events).forEach(function(topic) {
        Contract.events[topic] = contract.events[topic];
      });

      return;
    }

    if (typeof name == "object") {
      var obj = name;
      Object.keys(obj).forEach(function(name) {
        var a = obj[name];
        Contract.link(name, a);
      });
      return;
    }

    Contract.links[name] = address;
  };

  Contract.contract_name   = Contract.prototype.contract_name   = "ComDAO";
  Contract.generated_with  = Contract.prototype.generated_with  = "3.2.0";

  // Allow people to opt-in to breaking changes now.
  Contract.next_gen = false;

  var properties = {
    binary: function() {
      var binary = Contract.unlinked_binary;

      Object.keys(Contract.links).forEach(function(library_name) {
        var library_address = Contract.links[library_name];
        var regex = new RegExp("__" + library_name + "_*", "g");

        binary = binary.replace(regex, library_address.replace("0x", ""));
      });

      return binary;
    }
  };

  Object.keys(properties).forEach(function(key) {
    var getter = properties[key];

    var definition = {};
    definition.enumerable = true;
    definition.configurable = false;
    definition.get = getter;

    Object.defineProperty(Contract, key, definition);
    Object.defineProperty(Contract.prototype, key, definition);
  });

  bootstrap(Contract);

  if (typeof module != "undefined" && typeof module.exports != "undefined") {
    module.exports = Contract;
  } else {
    // There will only be one version of this contract in the browser,
    // and we can use that.
    window.ComDAO = Contract;
  }
})();
