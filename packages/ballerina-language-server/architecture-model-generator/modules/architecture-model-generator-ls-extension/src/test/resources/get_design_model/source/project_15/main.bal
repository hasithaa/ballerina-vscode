import ballerina/workflow;

type OrderInput record {|
    string orderId;
|};

@workflow:Activity
function checkStock(string orderId) returns string|error {
    return "IN_STOCK";
}

@workflow:DurableAgent
function orderAgent(workflow:AgentContext durableAgentContext, json query) returns error? {
    check durableAgentContext.registerUpdateEvents("chat", string);
    check durableAgentContext.registerUpdateEvents("paymentUpdate", OrderInput);
    check durableAgentContext.registerActivity(checkStock);
    check durableAgentContext.registerHumanTask("approveOrder", "MANAGER");
}
