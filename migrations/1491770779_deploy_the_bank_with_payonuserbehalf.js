module.exports = function(deployer) {
  // Use deployer to state migration tasks.
  deployer.deploy(TheBank,1,"PercCoin","PC");
};
