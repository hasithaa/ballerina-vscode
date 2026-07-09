/*
 *  Copyright (c) 2026, WSO2 LLC. (http://www.wso2.com)
 *
 *  WSO2 LLC. licenses this file to you under the Apache License,
 *  Version 2.0 (the "License"); you may not use this file except
 *  in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing,
 *  software distributed under the License is distributed on an
 *  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 *  KIND, either express or implied.  See the License for the
 *  specific language governing permissions and limitations
 *  under the License.
 */

package io.ballerina.flowmodelgenerator.core.model.node;

import io.ballerina.compiler.syntax.tree.SyntaxKind;
import io.ballerina.flowmodelgenerator.core.model.NodeKind;
import io.ballerina.flowmodelgenerator.core.model.Property;
import io.ballerina.flowmodelgenerator.core.model.SourceBuilder;
import io.ballerina.flowmodelgenerator.core.utils.WorkflowUtil;
import io.ballerina.modelgenerator.commons.FunctionData;
import io.ballerina.modelgenerator.commons.ParameterData;
import org.eclipse.lsp4j.TextEdit;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static io.ballerina.flowmodelgenerator.core.Constants.Workflow.AGENT_CONTEXT_CLASS_NAME;
import static io.ballerina.flowmodelgenerator.core.Constants.Workflow.RUN_DURABLE_AGENT_DESCRIPTION;
import static io.ballerina.flowmodelgenerator.core.Constants.Workflow.RUN_DURABLE_AGENT_LABEL;
import static io.ballerina.flowmodelgenerator.core.Constants.Workflow.RUN_DURABLE_AGENT_METHOD_NAME;
import static io.ballerina.flowmodelgenerator.core.Constants.Workflow.WORKFLOW_MODULE;
import static io.ballerina.flowmodelgenerator.core.Constants.Workflow.WORKFLOW_ORG;

/**
 * Runs the durable agent loop with the configured capabilities. Generates
 * {@code check ctx->runDurableAgent({systemPrompt: <prompt>}, <initialPrompt>);}.
 *
 * @since 1.8.0
 */
public class DurableAgentRunBuilder extends CallBuilder {

    public static final String SYSTEM_PROMPT_KEY = "systemPrompt";
    public static final String PROMPT_KEY = "prompt";
    private static final String STRING_TYPE = "string";

    @Override
    protected NodeKind getFunctionNodeKind() {
        return NodeKind.DURABLE_AGENT_RUN;
    }

    @Override
    protected FunctionData.Kind getFunctionResultKind() {
        return FunctionData.Kind.REMOTE;
    }

    @Override
    public void setConcreteConstData() {
        metadata().label(RUN_DURABLE_AGENT_LABEL).description(RUN_DURABLE_AGENT_DESCRIPTION);
        codedata()
                .node(NodeKind.DURABLE_AGENT_RUN)
                .org(WORKFLOW_ORG)
                .module(WORKFLOW_MODULE)
                .object(AGENT_CONTEXT_CLASS_NAME)
                .symbol(RUN_DURABLE_AGENT_METHOD_NAME);
    }

    @Override
    public void setConcreteTemplateData(TemplateContext context) {
        setConcreteConstData();
        properties().custom()
                .metadata()
                    .label("System Prompt")
                    .description("Instructions that define the agent's role and behaviour")
                    .stepOut()
                .type(Property.ValueType.EXPRESSION, STRING_TYPE)
                .codedata()
                    .kind(ParameterData.Kind.REQUIRED.name())
                    .stepOut()
                .placeholder("\"You are a helpful assistant.\"")
                .value("")
                .editable(true)
                .stepOut()
                .addProperty(SYSTEM_PROMPT_KEY);

        properties().custom()
                .metadata()
                    .label("Initial Prompt")
                    .description("Optional initial user prompt; when omitted the agent waits for the first chat event")
                    .stepOut()
                .type(Property.ValueType.EXPRESSION, STRING_TYPE)
                .codedata()
                    .kind(ParameterData.Kind.DEFAULTABLE.name())
                    .stepOut()
                .value("")
                .editable(true)
                .optional(true)
                .stepOut()
                .addProperty(PROMPT_KEY);
        properties().checkError(true);
    }

    @Override
    public Map<Path, List<TextEdit>> toSource(SourceBuilder sourceBuilder) {
        String ctxParamName = WorkflowUtil.resolveAgentContextParamName(sourceBuilder);
        Optional<Property> systemPromptProperty = sourceBuilder.getProperty(SYSTEM_PROMPT_KEY);
        String systemPrompt = systemPromptProperty
                .map(p -> p.value() == null ? "" : p.value().toString()).orElse("");
        if (systemPrompt.isBlank()) {
            throw new IllegalStateException("A system prompt is required");
        }
        Optional<Property> promptProperty = sourceBuilder.getProperty(PROMPT_KEY);
        String prompt = promptProperty.map(p -> p.value() == null ? "" : p.value().toString()).orElse("");

        sourceBuilder.token()
                .keyword(SyntaxKind.CHECK_KEYWORD)
                .name(ctxParamName)
                .keyword(SyntaxKind.RIGHT_ARROW_TOKEN)
                .name(RUN_DURABLE_AGENT_METHOD_NAME)
                .keyword(SyntaxKind.OPEN_PAREN_TOKEN)
                .keyword(SyntaxKind.OPEN_BRACE_TOKEN)
                .name(SYSTEM_PROMPT_KEY)
                .keyword(SyntaxKind.COLON_TOKEN)
                .name(systemPrompt)
                .keyword(SyntaxKind.CLOSE_BRACE_TOKEN);

        if (!prompt.isBlank()) {
            sourceBuilder.token()
                    .keyword(SyntaxKind.COMMA_TOKEN)
                    .name(prompt);
        }

        sourceBuilder.token()
                .keyword(SyntaxKind.CLOSE_PAREN_TOKEN)
                .endOfStatement();

        return sourceBuilder
                .textEdit()
                .acceptImport(WORKFLOW_ORG, WORKFLOW_MODULE)
                .build();
    }
}
