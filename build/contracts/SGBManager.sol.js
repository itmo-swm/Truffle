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
      throw new Error("SGBManager error: Please call setProvider() first before calling new().");
    }

    var args = Array.prototype.slice.call(arguments);

    if (!this.unlinked_binary) {
      throw new Error("SGBManager error: contract binary not set. Can't deploy new instance.");
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

      throw new Error("SGBManager contains unresolved libraries. You must deploy and link the following libraries before you can deploy a new version of SGBManager: " + unlinked_libraries);
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
      throw new Error("Invalid address passed to SGBManager.at(): " + address);
    }

    var contract_class = this.web3.eth.contract(this.abi);
    var contract = contract_class.at(address);

    return new this(contract);
  };

  Contract.deployed = function() {
    if (!this.address) {
      throw new Error("Cannot find deployed address: SGBManager not deployed or address not set.");
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
      }
    ],
    "unlinked_binary": "0x606060405234610000575b610af2806100196000396000f300606060405263ffffffff60e060020a600035041663259e1fa58114610050578063396dbe5c146101965780636954d2ba14610255578063a6413a2714610313578063b1a842c314610338575b610000565b34610000576100606004356103ac565b60408051888152606081018690526080810185905260a08101849052600160a060020a03831660c082015260e06020820181815289546002600182161561010090810260001901909216049284018390529293909290840191908401908a90801561010c5780601f106100e15761010080835404028352916020019161010c565b820191906000526020600020905b8154815290600101906020018083116100ef57829003601f168201915b50508381038252885460026000196101006001841615020190911604808252602090910190899080156101805780601f1061015557610100808354040283529160200191610180565b820191906000526020600020905b81548152906001019060200180831161016357829003601f168201915b5050995050505050505050505060405180910390f35b34610000576101a66004356103f8565b60408051868152600160a060020a03861660208201529081018490526060810183905260a0608082018181528354600260001961010060018416150201909116049183018290529060c0830190849080156102425780601f1061021757610100808354040283529160200191610242565b820191906000526020600020905b81548152906001019060200180831161022557829003601f168201915b5050965050505050505060405180910390f35b3461000057610301600480803590602001908201803590602001908080601f0160208091040260200160405190810160405280939291908181526020018383808284375050604080516020601f89358b0180359182018390048302840183019094528083529799988101979196509182019450925082915084018382808284375094965050843594602081013594506040810135935060600135600160a060020a0316915061043f9050565b60408051918252519081900360200190f35b34610000576103016004356024356107d8565b60408051918252519081900360200190f35b3461000057604080516020600460643581810135601f8101849004840285018401909552848452610301948235600160a060020a0316946024803595604435959460849492019190819084018382808284375094965061080795505050505050565b60408051918252519081900360200190f35b600081815481101561000057906000526020600020906007020160005b5080546003820154600483015460058401546006850154939550600185019460020193600160a060020a031687565b600181815481101561000057906000526020600020906005020160005b508054600182015460028301546003840154929450600160a060020a039091169290919060040185565b60006000600080548091906001018154818355818115116105755760070281600702836000526020600020918201910161057591905b808211156104de576000600082016000905560018201805460018160011615610100020316600290046000825580601f106104b057506104e2565b601f0160209004906000526020600020908101906104e291905b808211156104de57600081556001016104ca565b5090565b5b5060028201805460018160011615610100020316600290046000825580601f1061050d575061053f565b601f01602090049060005260206000209081019061053f91905b808211156104de57600081556001016104ca565b5090565b5b5050600060038201819055600482018190556005820155600681018054600160a060020a0319169055600701610475565b5090565b5b505050905060e06040519081016040528082815260200189815260200188815260200187815260200186815260200185815260200184600160a060020a0316815250600082815481101561000057906000526020600020906007020160005b50600082015181600001556020820151816001019080519060200190828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f1061063257805160ff191683800117855561065f565b8280016001018555821561065f579182015b8281111561065f578251825591602001919060010190610644565b5b506106809291505b808211156104de57600081556001016104ca565b5090565b50506040820151816002019080519060200190828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f106106d457805160ff1916838001178555610701565b82800160010185558215610701579182015b828111156107015782518255916020019190600101906106e6565b5b506107229291505b808211156104de57600081556001016104ca565b5090565b5050606082015160038201556080820151600482015560a082015160058083019190915560c09092015160069091018054600160a060020a031916600160a060020a03909216919091179055604080517f4144444544000000000000000000000000000000000000000000000000000000815290519081900390910181209082907f5612519f74fc0cb539f45097dbb05ddda76697851b926dd5007579f3313d588a90600090a38091505b509695505050505050565b6000600082815481101561000057906000526020600020906007020160005b5060030154830290505b92915050565b60006000600180548091906001018154818355818115116108d4576005028160050283600052602060002091820191016108d491905b808211156104de57600080825560018083018054600160a060020a0319169055600280840183905560038401839055600484018054848255909281161561010002600019011604601f81901061089357506108c5565b601f0160209004906000526020600020908101906108c591905b808211156104de57600081556001016104ca565b5090565b5b505060050161083d565b5090565b5b505050905060a06040519081016040528082815260200187600160a060020a0316815260200186815260200185815260200184815250600182815481101561000057906000526020600020906005020160005b506000820151816000015560208201518160010160006101000a815481600160a060020a030219169083600160a060020a0316021790555060408201518160020155606082015181600301556080820151816004019080519060200190828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f106109c657805160ff19168380011785556109f3565b828001600101855582156109f3579182015b828111156109f35782518255916020019190600101906109d8565b5b50610a149291505b808211156104de57600081556001016104ca565b5090565b5050905050826040518082805190602001908083835b60208310610a495780518252601f199092019160209182019101610a2a565b51815160209384036101000a6000190180199092169116179052604080519290940182900382208a835293519395508a9450600160a060020a038c16937f792a00dadd1ba2b436e7c812ef8b79defe41dd8b79691a04164e2f751915a4b49350918290030190a4610aba84866107d8565b91505b509493505050505600a165627a7a72305820b26b08e0c64f4fab5de43f8fd7872dc807fcf17871a29992b7d07c75db476a150029",
    "events": {
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
      }
    },
    "updated_at": 1491130333776,
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

  Contract.contract_name   = Contract.prototype.contract_name   = "SGBManager";
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
    window.SGBManager = Contract;
  }
})();
