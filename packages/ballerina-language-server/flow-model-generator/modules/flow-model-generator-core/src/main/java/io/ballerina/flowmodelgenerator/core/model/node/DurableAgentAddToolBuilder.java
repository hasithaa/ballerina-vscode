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

import io.ballerina.compiler.api.symbols.AnnotationAttachmentSymbol;
import io.ballerina.compiler.api.symbols.FunctionSymbol;
import io.ballerina.compiler.api.symbols.Symbol;
import io.ballerina.compiler.api.symbols.SymbolKind;
import io.ballerina.compiler.syntax.tree.SyntaxKind;
import io.ballerina.flowmodelgenerator.core.Constants;
import io.ballerina.flowmodelgenerator.core.model.NodeKind;
import io.ballerina.flowmodelgenerator.core.model.Option;
import io.ballerina.flowmodelgenerator.core.model.Property;
import io.ballerina.flowmodelgenerator.core.model.SourceBuilder;
import io.ballerina.flowmodelgenerator.core.utils.WorkflowUtil;
import io.ballerina.modelgenerator.commons.FunctionData;
import io.ballerina.modelgenerator.commons.PackageUtil;
import io.ballerina.modelgenerator.commons.ParameterData;
import io.ballerina.projects.Package;
import org.eclipse.lsp4j.TextEdit;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static io.ballerina.flowmodelgenerator.core.Constants.Workflow.AGENT_CONTEXT_CLASS_NAME;
import static io.ballerina.flowmodelgenerator.core.Constants.Workflow.REGISTER_TOOLS_METHOD_NAME;
import static io.ballerina.flowmodelgenerator.core.Constants.Workflow.REGISTER_TOOL_DESCRIPTION;
import static io.ballerina.flowmodelgenerator.core.Constants.Workflow.REGISTER_TOOL_LABEL;
import static io.ballerina.flowmodelgenerator.core.Constants.Workflow.WORKFLOW_MODULE;
import static io.ballerina.flowmodelgenerator.core.Constants.Workflow.WORKFLOW_ORG;

/**
 * Registers an AI tool with the durable agent. Generates
 * {@code check ctx.registerTools([<tool>]);} where the tool is an {@code @ai:AgentTool} function.
 *
 * @since 1.8.0
 */
public class DurableAgentAddToolBuilder extends CallBuilder {

    public static final String TOOL_KEY = "tool";
    public static final String TOOL_LABEL = "Tool";
    public static final String TOOL_DOC = "The @ai:AgentTool function to expose to the agent";
    private static final String AGENT_TOOL_ANNOTATION = "AgentTool";

    @Override
    protected NodeKind getFunctionNodeKind() {
        return NodeKind.DURABLE_AGENT_ADD_TOOL;
    }

    @Override
    protected FunctionData.Kind getFunctionResultKind() {
        return FunctionData.Kind.FUNCTION;
    }

    @Override
    public void setConcreteConstData() {
        metadata().label(REGISTER_TOOL_LABEL).description(REGISTER_TOOL_DESCRIPTION);
        codedata()
                .node(NodeKind.DURABLE_AGENT_ADD_TOOL)
                .org(WORKFLOW_ORG)
                .module(WORKFLOW_MODULE)
                .object(AGENT_CONTEXT_CLASS_NAME)
                .symbol(REGISTER_TOOLS_METHOD_NAME);
    }

    @Override
    public void setConcreteTemplateData(TemplateContext context) {
        setConcreteConstData();
        properties().custom()
                .metadata()
                    .label(TOOL_LABEL)
                    .description(TOOL_DOC)
                    .stepOut()
                .type()
                    .fieldType(Property.ValueType.SINGLE_SELECT)
                    .options(getAgentToolFunctions(context))
                    .selected(true)
                    .stepOut()
                .codedata()
                    .kind(ParameterData.Kind.REQUIRED.name())
                    .stepOut()
                .value("")
                .editable(true)
                .stepOut()
                .addProperty(TOOL_KEY);
        properties().checkError(true);
    }

    @Override
    public Map<Path, List<TextEdit>> toSource(SourceBuilder sourceBuilder) {
        String ctxParamName = WorkflowUtil.resolveAgentContextParamName(sourceBuilder);
        Optional<Property> toolProperty = sourceBuilder.getProperty(TOOL_KEY);
        String tool = toolProperty.map(p -> p.value() == null ? "" : p.value().toString()).orElse("");
        if (tool.isBlank()) {
            throw new IllegalStateException("A tool function must be selected");
        }

        sourceBuilder.token()
                .keyword(SyntaxKind.CHECK_KEYWORD)
                .name(ctxParamName)
                .keyword(SyntaxKind.DOT_TOKEN)
                .name(REGISTER_TOOLS_METHOD_NAME)
                .keyword(SyntaxKind.OPEN_PAREN_TOKEN)
                .keyword(SyntaxKind.OPEN_BRACKET_TOKEN)
                .name(tool)
                .keyword(SyntaxKind.CLOSE_BRACKET_TOKEN)
                .keyword(SyntaxKind.CLOSE_PAREN_TOKEN)
                .endOfStatement();

        return sourceBuilder
                .textEdit()
                .acceptImport(WORKFLOW_ORG, WORKFLOW_MODULE)
                .build();
    }

    private List<Option> getAgentToolFunctions(TemplateContext context) {
        List<Option> options = new ArrayList<>();
        Package currentPackage = PackageUtil.loadProject(context.workspaceManager(), context.filePath())
                .currentPackage();
        PackageUtil.getCompilation(currentPackage);
        currentPackage.modules().forEach(module ->
                module.getCompilation().getSemanticModel().moduleSymbols().stream()
                        .filter(symbol -> symbol.kind() == SymbolKind.FUNCTION)
                        .map(symbol -> (FunctionSymbol) symbol)
                        .filter(DurableAgentAddToolBuilder::isAgentToolFunction)
                        .forEach(funcSymbol -> funcSymbol.getName().ifPresent(name ->
                                options.add(new Option(name, name)))));
        return options;
    }

    private static boolean isAgentToolFunction(Symbol symbol) {
        if (symbol == null || symbol.kind() != SymbolKind.FUNCTION) {
            return false;
        }
        for (AnnotationAttachmentSymbol attachment : ((FunctionSymbol) symbol).annotAttachments()) {
            Optional<String> name = attachment.typeDescriptor().getName();
            boolean isAiModule = attachment.typeDescriptor().getModule()
                    .map(module -> Constants.Ai.AI_PACKAGE.equals(module.id().moduleName()))
                    .orElse(false);
            if (name.isPresent() && AGENT_TOOL_ANNOTATION.equals(name.get()) && isAiModule) {
                return true;
            }
        }
        return false;
    }
}
