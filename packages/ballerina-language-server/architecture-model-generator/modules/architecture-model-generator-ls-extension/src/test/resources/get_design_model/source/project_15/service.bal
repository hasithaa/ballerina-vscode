import ballerina/http;
import ballerina/workflow;

listener http:Listener agentListener = http:getDefaultListener();

service /agent on agentListener {

    resource function post 'start(string orderId) returns string|error {
        return check workflow:runDurableAgent(orderAgent, {orderId: orderId});
    }

    resource function post chat(string agentId, string message) returns anydata|error {
        return check workflow:updateAgent(orderAgent, agentId, "chat", message);
    }
}
