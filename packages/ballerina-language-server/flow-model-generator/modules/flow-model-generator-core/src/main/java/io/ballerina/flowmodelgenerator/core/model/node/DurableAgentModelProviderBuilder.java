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

import io.ballerina.compiler.api.symbols.ClassSymbol;
import io.ballerina.compiler.api.symbols.Symbol;
import io.ballerina.compiler.api.symbols.SymbolKind;
import io.ballerina.compiler.api.symbols.TypeSymbol;
import io.ballerina.compiler.api.symbols.VariableSymbol;
import io.ballerina.compiler.syntax.tree.SyntaxKind;
import io.ballerina.flowmodelgenerator.core.Constants;
import io.ballerina.flowmodelgenerator.core.model.NodeKind;
import io.ballerina.flowmodelgenerator.core.model.Option;
import io.ballerina.flowmodelgenerator.core.model.Property;
import io.ballerina.flowmodelgenerator.core.model.SourceBuilder;
import io.ballerina.flowmodelgenerator.core.utils.TypeUtils;
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
import static io.ballerina.flowmodelgenerator.core.Constants.Workflow.SET_MODEL_PROVIDER_DESCRIPTION;
import static io.ballerina.flowmodelgenerator.core.Constants.Workflow.SET_MODEL_PROVIDER_LABEL;
import static io.ballerina.flowmodelgenerator.core.Constants.Workflow.SET_MODEL_PROVIDER_METHOD_NAME;
import static io.ballerina.flowmodelgenerator.core.Constants.Workflow.WORKFLOW_MODULE;
import static io.ballerina.flowmodelgenerator.core.Constants.Workflow.WORKFLOW_ORG;

/**
 * Represents the durable agent's model provider configuration node. Generates
 * {@code ctx.setModelProvider(<provider>);} where the provider is selected from the module-level
 * {@code ai:ModelProvider} variables of the project.
 *
 * @since 1.8.0
 */
public class DurableAgentModelProviderBuilder extends CallBuilder {

    public static final String MODEL_KEY = "model";
    public static final String MODEL_LABEL = "Model Provider";
    public static final String MODEL_DOC = "The module-level model provider variable used for the agent's LLM calls";

    @Override
    protected NodeKind getFunctionNodeKind() {
        return NodeKind.DURABLE_AGENT_MODEL_PROVIDER;
    }

    @Override
    protected FunctionData.Kind getFunctionResultKind() {
        return FunctionData.Kind.FUNCTION;
    }

    @Override
    public void setConcreteConstData() {
        metadata().label(SET_MODEL_PROVIDER_LABEL).description(SET_MODEL_PROVIDER_DESCRIPTION);
        codedata()
                .node(NodeKind.DURABLE_AGENT_MODEL_PROVIDER)
                .org(WORKFLOW_ORG)
                .module(WORKFLOW_MODULE)
                .object(AGENT_CONTEXT_CLASS_NAME)
                .symbol(SET_MODEL_PROVIDER_METHOD_NAME);
    }

    @Override
    public void setConcreteTemplateData(TemplateContext context) {
        setConcreteConstData();
        properties().custom()
                .metadata()
                    .label(MODEL_LABEL)
                    .description(MODEL_DOC)
                    .stepOut()
                .type()
                    .fieldType(Property.ValueType.SINGLE_SELECT)
                    .options(getModelProviderVariables(context))
                    .selected(true)
                    .stepOut()
                .codedata()
                    .kind(ParameterData.Kind.REQUIRED.name())
                    .stepOut()
                .value("")
                .editable(true)
                .stepOut()
                .addProperty(MODEL_KEY);
    }

    @Override
    public Map<Path, List<TextEdit>> toSource(SourceBuilder sourceBuilder) {
        String ctxParamName = WorkflowUtil.resolveAgentContextParamName(sourceBuilder);
        Optional<Property> modelProperty = sourceBuilder.getProperty(MODEL_KEY);
        String model = modelProperty.map(p -> p.value() == null ? "" : p.value().toString()).orElse("");
        if (model.isBlank()) {
            throw new IllegalStateException("A model provider must be selected");
        }

        sourceBuilder.token()
                .name(ctxParamName)
                .keyword(SyntaxKind.DOT_TOKEN)
                .name(SET_MODEL_PROVIDER_METHOD_NAME)
                .keyword(SyntaxKind.OPEN_PAREN_TOKEN)
                .name(model)
                .keyword(SyntaxKind.CLOSE_PAREN_TOKEN)
                .endOfStatement();

        return sourceBuilder
                .textEdit()
                .acceptImport(WORKFLOW_ORG, WORKFLOW_MODULE)
                .build();
    }

    /**
     * Lists the module-level variables whose type is (or includes) {@code ai:ModelProvider}.
     */
    private List<Option> getModelProviderVariables(TemplateContext context) {
        List<Option> options = new ArrayList<>();
        Package currentPackage = PackageUtil.loadProject(context.workspaceManager(), context.filePath())
                .currentPackage();
        PackageUtil.getCompilation(currentPackage);
        currentPackage.modules().forEach(module ->
                module.getCompilation().getSemanticModel().moduleSymbols().stream()
                        .filter(symbol -> symbol.kind() == SymbolKind.VARIABLE)
                        .map(symbol -> (VariableSymbol) symbol)
                        .filter(variable -> isModelProviderType(variable.typeDescriptor()))
                        .forEach(variable -> variable.getName().ifPresent(name ->
                                options.add(new Option(name, name)))));
        return options;
    }

    private static boolean isModelProviderType(TypeSymbol typeSymbol) {
        return isModelProviderType(typeSymbol, 0);
    }

    private static boolean isModelProviderType(TypeSymbol typeSymbol, int depth) {
        if (typeSymbol == null || depth > 4) {
            return false;
        }
        TypeSymbol resolved = TypeUtils.resolveTypeReference(typeSymbol);
        if (isAiModelProviderRef(typeSymbol) || isAiModelProviderRef(resolved)) {
            return true;
        }
        if (resolved instanceof ClassSymbol classSymbol) {
            for (TypeSymbol inclusion : classSymbol.typeInclusions()) {
                if (isModelProviderType(inclusion, depth + 1)) {
                    return true;
                }
            }
        }
        return false;
    }

    private static boolean isAiModelProviderRef(Symbol symbol) {
        if (symbol == null) {
            return false;
        }
        Optional<String> name = symbol.getName();
        if (name.isEmpty() || !name.get().endsWith(Constants.Ai.MODEL_PROVIDER_TYPE_NAME)) {
            return false;
        }
        return symbol.getModule()
                .map(module -> Constants.Ai.AI_PACKAGE.equals(module.id().moduleName()))
                .orElse(false);
    }
}
