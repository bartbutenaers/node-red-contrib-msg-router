module.exports = function(RED) {
    "use strict";
    var WRRPeers = require('weighted-round-robin');
    var HashRing = require('hashring');
    
    function MessageRouterNode(config) {
        RED.nodes.createNode(this,config);
        this.routerType        = config.routerType;
        this.topicDependent    = config.topicDependent;
        this.msgKeyField       = config.msgKeyField || 'payload';
        this.msgOutputField    = config.msgOutputField || 'output';
        this.delaying          = config.delaying;
        this.msgControl        = config.msgControl;
        this.outputsInfo       = config.outputsInfo || [];
        this.timerIds          = [];
        this.lastUsedOutputIndex = new Map();
        this.peers             = new WRRPeers(); 
        this.hashRing          = new HashRing();
    
        var node = this;
        
        function calculateDelays() {
            var outputInfo = {};
            var delaySum = 0;
            
            // Calculate the real delays, based on the delay values (of each output) and their relation type.
            for (var i = 0; i < node.outputsInfo.length; i++) {
                outputInfo =  node.outputsInfo[i];
                
                // Correct the delay by adding the delay sum of the previous 'relevant' output.
                // Remark: the original delay's can be unknown, wich we will default to 0.
                outputInfo.correctedDelay = parseInt(outputInfo.delay || 0) + delaySum;
                
                switch (node.delaying) {
                    case 'unrelated':
                        // There are no relations between the individual delays, so no adjustements required (delaySum = 0).
                        break;
                    case 'increment_all':
                        // Use all outputs for calculating the delay sum
                        delaySum += parseInt(outputInfo.delay);      
                        break;
                    case 'increment_active':
                        // Only use the active outputs for calculating the delay sum
                        if (outputInfo.active) {
                            delaySum += parseInt(outputInfo.delay); 
                        }                            
                        break;
                }
            }
        }
        
        // Initialize the Weighted Round Robin pool
        function calculateWeights() {
            // Remove all current peers (i.e. remove all peirs where the function returns true)
            node.peers.remove(function(peer){
                return true;
            });
            
            // Get the weight for every active output (from the config screen), and register the outputs and their weights in the pool.
            for (var i = 0; i < node.outputsInfo.length; i++) {
                var weight = parseInt(node.outputsInfo[i].weight);
                
                // Ignore the inactive outputs.  Remark: you cannot simply register them (in node.peers), since that library sets
                // the weights to a minimum of 10...
                if (node.outputsInfo[i].active) {
                    node.peers.add({ server:i, weight:weight });
                }
            }
        }
        
        function calculateHashes() {
            // Remove all current hashes
            node.hashRing.reset();

            // Remark: the 'hashring' module expects a server hostname, so we will pass it '127.0.0.<output number>' to map to our output numbers.
            for (var i = 0; i < node.outputsInfo.length; i++) {
                var weight = parseInt(node.outputsInfo[i].weight);
                
                if (node.routerType !== "weightedhashing") {
                    weight = 10;
                }
                
                if (node.outputsInfo[i].active) {
                    node.hashRing.add({['127.0.0.' + i]: weight});
                }
            }
        }
        
        calculateDelays();
        calculateWeights();
        calculateHashes();
        
        this.on("input", function(msg) {
            var messages = new Array(node.outputsInfo.length);
            var delayMap = new Map();
            var delayMessages = null;
            var outputInfo = null;
            var timerId = null;
            var output = 0;
            var outputIndex = 0;
            var activeOutputsIndices = [];
            var msgKeyValue;
            
            // -------------------------------------------------------------------------------------
            // PRE-PROCESSING
            // -------------------------------------------------------------------------------------
            
            // Caution: the output numbers (specified in the message) will start from 1, not from 0 !
            // So not zero-based ...
            if (msg.hasOwnProperty('output')) {
                if (!Number.isInteger(msg.output)) {
                    return node.error("The msg.output field contains no valid number");
                }
                
                output = parseInt(msg.output);
                
                if (output <= 0 || output > node.outputsInfo.length) {
                    return node.error("The msg.output field contains " + msg.output + ", which is not between 1 and " + node.outputsInfo.length);
                }
                
                // Make sure it is zero based in the remainder of the code
                output--;
                            
                // When the outputs can be configured using input messages, check whether the input message contains configuration fields
                if (node.msgControl) {
                    var controlMessage = false;
                    
                    outputInfo = node.outputsInfo[output];
                    
                    if (msg.hasOwnProperty('active')) {
                        if (msg.active !== false && msg.active !== true) {
                            return node.error("The msg.active field should contain true or false");
                        }
                        
                        outputInfo.active = Boolean(msg.active);
                        controlMessage = true;
                        
                        // When outputs are being (de)activated, it could be necessary to recalculate the delays and weights
                        calculateDelays();
                        calculateWeights();
                        calculateHashes();
                    }
                    
                    if (msg.hasOwnProperty('weigth')) {
                        if (!Number.isInteger(msg.weigth)) {
                            return node.error("The msg.weigth field should contain a valid integer number");
                        }
                        
                        outputInfo.weigth = parseInt(msg.weigth);
                        controlMessage = true;
                        
                        // When weights are changed, it will be necessary to recalculate the weight pool
                        calculateWeights();

                    }
                    
                    if (msg.hasOwnProperty('clone')) {
                        if (msg.clone !== false && msg.clone !== true) {
                            return node.error("The msg.clone field should contain true or false");
                        }
                        
                        outputInfo.clone = Boolean(msg.clone);                   
                        controlMessage = true;
                    }
                    
                    if (controlMessage) {
                        // When we discovered msg.output together with at least one of the remote control fields (msg.active, msg.weigth, msg.clone),
                        // then we are dealing with a control message.  Such a message shouldn't be routed to the outputs...
                        return;
                    }
                }                  
            }
            
            // Create an array of (zero-based) active output indices (i.e. indices of active outputs in node.outputsInfo).
            for (var i = 0; i < node.outputsInfo.length; i++) {
                outputInfo = node.outputsInfo[i];
                
                if (outputInfo.active) {
                    activeOutputsIndices.push(i);
                }  
            }      

            // Quit when all outputs are inactive, because nothing can be routed anyway
            if (activeOutputsIndices.length === 0) {
                return;
            }

            // Let's start with a null (i.e. no message) for every output
            messages.fill(null);
            
            // -------------------------------------------------------------------------------------
            // PROCESSING
            // -------------------------------------------------------------------------------------
 
            switch (node.routerType) {
                case "broadcast":
                    // Send the input message to all active output
                    for (var i = 0; i < activeOutputsIndices.length; i++) {
                        outputIndex = activeOutputsIndices[i];
                        messages[outputIndex] = msg;
                    }
                     
                    break; 
                case "message":
                    if (!msg.hasOwnProperty('output')) {
                        return node.error("The input message doesn't have have a msg.output field");
                    }
                    
                    try {
                        msgKeyValue = RED.util.getMessageProperty(msg, 'output');
                    } 
                    catch(err) {
                        node.error("The msg.output field can not be read");
                        return;
                    }
                    
                    if (isNaN(msgKeyValue)) {
                        return node.error("The msg.output is not an integer output number");
                    }
                    
                    if (msgKeyValue < 1 || msgKeyValue > node.outputsInfo.length) {
                        return node.error("The msg.output = " + node.msgKeyValue + " , which should be between 1 and " + node.outputsInfo.length);
                    }
                    
                    if (!node.outputsInfo[msgKeyValue - 1].active) {
                        return node.error("The msg.output = " + node.msgKeyValue + ", which refers to an inactive output");
                    }
                                        
                    // Send the message to the specified output
                    messages[output] = msg;
                    
                    break;
                case "random":
                    // Get a random active output
                    outputIndex = Math.floor(Math.random() * activeOutputsIndices.length);
                    var randomOutput = activeOutputsIndices[outputIndex];

                    // Send the message to the random determined output, and don't send anything (= null) on the other outputs.
                    messages[randomOutput] = msg;
                
                    break;
                case "roundrobin":
                    var topic = node.topicDependent ? msg.topic : "all_topics";
                    outputIndex = node.lastUsedOutputIndex.get(topic);
                    
                    if (outputIndex == undefined) {
                        // Start sending from index 1 
                        outputIndex = 0;
                    }
                    else {
                        outputIndex++;
                        
                        // When a message has been send to all outputs yet, start again from output 1
                        if (outputIndex >= activeOutputsIndices.length) {
                            outputIndex = 0;
                        }                        
                    }
                    
                    var lastUsedOutput = activeOutputsIndices[outputIndex];
                    
                    // Send the output message to the next 'active' output number
                    messages[lastUsedOutput] = msg;
                    
                    // Remember the last used index, for the next message
                    node.lastUsedOutputIndex.set(topic, outputIndex);
                
                    break;
                case "weightedroundrobin":
                    // Get the next active output index from the pool (based on the specified weights). 
                    var weightedOutput = node.peers.get().server;
                    
                    // Send the output message only to the weighted output number
                    messages[weightedOutput] = msg;   
                
                    break;
                // Both types of hashing are implemented with the same coding (so use case fallthrough).
                // The only difference is the weights that have been applied earlier ...
                case "hashing":
                case "weightedhashing":      
                    if (!node.msgKeyField) {
                        return node.error("No msg field is specified in config (for hash value)");
                    }
                    
                    if (!msg.hasOwnProperty(node.msgKeyField)) {
                        return node.error("The input message doesn't have have a msg." + node.msgKeyField + " field");
                    }
                    
                    try {
                        msgKeyValue = RED.util.getMessageProperty(msg, node.msgKeyField);
                    } 
                    catch(err) {
                        node.error("The msg." + node.msgKeyField + " field can not be read");
                        return;
                    }

                    // Get the output that corresponds to the (hashed) message field value.  Remark: since we had to store our
                    // output numbers as server hostname '127.0.0.<output number>', the first slice needs to be removed.
                    var hashedOutput = node.hashRing.get(msgKeyValue).slice(8); 
                
                    // Send the output message only to the hashed output number
                    messages[hashedOutput] = msg; 

                    break;
            }
            
            // -------------------------------------------------------------------------------------
            // POST-PROCESSING
            // -------------------------------------------------------------------------------------

            for (var i = 0; i < node.outputsInfo.length; i++) {
                outputInfo =  node.outputsInfo[i];
                
                // Clone messages as specified
                if (outputInfo.clone && messages[i]) {
                    try {
                        messages[i] = RED.util.cloneMessage(messages[i]);
                    }
                    catch(e) {
                        node.warn("The input message cannot be cloned");
                        
                        // Cloning failed, so don't send a message on this output
                        messages[i] = null;
                    }
                }                    
                
                // Store all (non-null) messages in the map, GROUPED BY DELAY (also delay 0).
                // For example:
                //       messages = [null, msg1 (delay X), null, msg2 (delay Y), null, msg3 (delay Y), null]
                // The resulting delayMap will get following key-value pairs:
                //       X -> [null, msg1 (delay X), null, null, null, null, null]
                //       Y -> [null, null, null, msg2 (delay Y), null, msg3 (delay Y), null]
                if (messages[i]) {
                    delayMessages = delayMap.get(outputInfo.correctedDelay);
                    
                    if (!delayMessages) {
                        delayMessages = Array(node.outputsInfo.length).fill(null);
                        delayMap.set(outputInfo.correctedDelay, delayMessages);
                    }

                    delayMessages[i] = messages[i];
                }                
            }
            
            // At this moment the delayMap contains the messages grouped by delay:
            //       X -> [null, msg1 (delay X), null, null, null, null, null]
            //       Y -> [null, null, null, msg2 (delay Y), null, msg3 (delay Y), null]
            // Only thing we need to do, is to schedule sending those message groups at the corresponding delay
            delayMap.forEach(function (item, key, mapObj) {  
                if (key === 0) {
                    // For delay 0 milliseconds we can send the messages to the outputs immediately
                    node.send(messages);
                }  
                else {
                    // When a delay is specified (i.e. non-zero map key), the messages need to be send delayed to the outputs.
                    timerId = setTimeout( function () {                       
                        node.send(item);
                        
                        var index = node.timerIds.indexOf(timerId);
                        delete node.timerIds[index];
                        clearInterval(timerId);
                        
                        // Clear the array
                        item.length = 0;
                    }, key); 
                    
                    // Store the timer id, so we can access it afterwards
                    node.timerIds.push(timerId);
                }
            });
            
            delayMap.clear();
        });
        
        node.on("close", function() {
            // Stop all the timers that are currently running
            for(var timerId of node.timerIds) {
                clearInterval(timerId);
            }
            // Clear the array
            node.timerIds.length = 0;
            
            // Remove all peers (i.e. remove all peirs where the function returns true)
            node.peers.remove(function(peer){
                return true;
            });
        });
    }

    RED.nodes.registerType("msg-router",MessageRouterNode);
    
    // Make all the static resources from this node public available (i.e. third party JQuery plugin tableHeadFixer.js).
    // TODO is dit nodig?  of gewoon een script file includen op de html
    RED.httpAdmin.get('/msg_router/js/*', function(req, res){
        var options = {
            root: __dirname /*+ '/static/'*/,
            dotfiles: 'deny'
        };
       
        // Send the requested file to the client (in this case it will be tableHeadFixer.js)
        res.sendFile(req.params[0], options)
    });
};
