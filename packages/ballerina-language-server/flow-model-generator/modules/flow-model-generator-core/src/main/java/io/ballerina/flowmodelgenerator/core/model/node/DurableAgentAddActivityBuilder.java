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

import io.ballerina.compiler.api.symbols.FunctionSymbol;
import io.ballerina.compiler.api.symbols.SymbolKind;
import io.ballerina.compiler.syntax.tree.SyntaxKind;
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
import static io.ballerina.flowmodelgenerator.core.Constants.Workflow.REGISTER_ACTIVITIES_METHOD_NAME;
import static io.ballerina.flowmodelgenerator.core.Constants.Workflow.REGISTER_ACTIVITY_DESCRIPTION;
import static io.ballerina.flowmodelgenerator.core.Constants.Workflow.REGISTER_ACTIVITY_LABEL;
import static io.ballerina.flowmodelgenerator.core.Constants.Workflow.WORKFLOW_MODULE;
import static io.ballerina.flowmodelgenerator.core.Constants.Workflow.WORKFLOW_ORG;

/**
 * Registers a workflow activity as a durable agent tool. Generates
 * {@code check ctx.registerActivities([<activity>]);}.
 *
 * @since 1.8.0
 */
public class DurableAgentAddActivityBuilder extends CallBuilder {

    public static final String ACTIVITY_KEY = "activity";
    public static final String ACTIVITY_LABEL = "Activity";
    public static final String ACTIVITY_DOC = "The @workflow:Activity function to expose as an agent tool";

    @Override
    protected NodeKind getFunctionNodeKind() {
        return NodeKind.DURABLE_AGENT_ADD_ACTIVITY;
    }

    @Override
    protected FunctionData.Kind getFunctionResultKind() {
        return FunctionData.Kind.FUNCTION;
    }

    @Override
    public void setConcreteConstData() {
        metadata().label(REGISTER_ACTIVITY_LABEL).description(REGISTER_ACTIVITY_DESCRIPTION);
        codedata()
                .node(NodeKind.DURABLE_AGENT_ADD_ACTIVITY)
                .org(WORKFLOW_ORG)
                .module(WORKFLOW_MODULE)
                .object(AGENT_CONTEXT_CLASS_NAME)
                .symbol(REGISTER_ACTIVITIES_METHOD_NAME);
    }

    @Override
    public void setConcreteTemplateData(TemplateContext context) {
        setConcreteConstData();
        properties().custom()
                .metadata()
                    .label(ACTIVITY_LABEL)
                    .description(ACTIVITY_DOC)
                    .stepOut()
                .type()
                    .fieldType(Property.ValueType.SINGLE_SELECT)
                    .options(getActivityFunctions(context))
                    .selected(true)
                    .stepOut()
                .codedata()
                    .kind(ParameterData.Kind.REQUIRED.name())
                    .stepOut()
                .value("")
                .editable(true)
                .stepOut()
                .addProperty(ACTIVITY_KEY);
        properties().checkError(true);
    }

    @Override
    public Map<Path, List<TextEdit>> toSource(SourceBuilder sourceBuilder) {
        String ctxParamName = WorkflowUtil.resolveAgentContextParamName(sourceBuilder);
        Optional<Property> activityProperty = sourceBuilder.getProperty(ACTIVITY_KEY);
        String activity = activityProperty.map(p -> p.value() == null ? "" : p.value().toString()).orElse("");
        if (activity.isBlank()) {
            throw new IllegalStateException("An activity function must be selected");
        }

        sourceBuilder.token()
                .keyword(SyntaxKind.CHECK_KEYWORD)
                .name(ctxParamName)
                .keyword(SyntaxKind.DOT_TOKEN)
                .name(REGISTER_ACTIVITIES_METHOD_NAME)
                .keyword(SyntaxKind.OPEN_PAREN_TOKEN)
                .keyword(SyntaxKind.OPEN_BRACKET_TOKEN)
                .name(activity)
                .keyword(SyntaxKind.CLOSE_BRACKET_TOKEN)
                .keyword(SyntaxKind.CLOSE_PAREN_TOKEN)
                .endOfStatement();

        return sourceBuilder
                .textEdit()
                .acceptImport(WORKFLOW_ORG, WORKFLOW_MODULE)
                .build();
    }

    private List<Option> getActivityFunctions(TemplateContext context) {
        List<Option> options = new ArrayList<>();
        Package currentPackage = PackageUtil.loadProject(context.workspaceManager(), context.filePath())
                .currentPackage();
        PackageUtil.getCompilation(currentPackage);
        currentPackage.modules().forEach(module ->
                module.getCompilation().getSemanticModel().moduleSymbols().stream()
                        .filter(symbol -> symbol.kind() == SymbolKind.FUNCTION)
                        .map(symbol -> (FunctionSymbol) symbol)
                        .filter(WorkflowUtil::isActivityFunction)
                        .forEach(funcSymbol -> funcSymbol.getName().ifPresent(name ->
                                options.add(new Option(name, name)))));
        return options;
    }
}
