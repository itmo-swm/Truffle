var config = require('./config');
require('./mqtt-client');
/*var telegram = require('./telegram');
telegram.connect();*/

module.exports = {
  build: {
    "index.html": "index.html",
    "app.js": [
      "javascripts/app.js"
    ],
    "app.css": [
      "stylesheets/app.css"
    ],
    "images/": "images/"
  },
  rpc: {
    host: config.rpc_server,
    port: config.rpc_port
  }
};
