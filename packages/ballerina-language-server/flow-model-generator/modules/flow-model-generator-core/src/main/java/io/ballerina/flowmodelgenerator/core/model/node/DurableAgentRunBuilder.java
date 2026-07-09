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
import io.ballerina.modelgenerator.commons.FunctionDataBuilder;
import io.ballerina.modelgenerator.commons.ModuleInfo;
import io.ballerina.modelgenerator.commons.PackageUtil;
import io.ballerina.modelgenerator.commons.ParameterData;
import io.ballerina.projects.Module;
import io.ballerina.projects.Package;
import org.eclipse.lsp4j.TextEdit;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
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
 * Runs the durable agent loop. The form mirrors a regular {@code ai:Agent}: the included
 * {@code AgentRunConfig} record expands into the same fields (system prompt, model, tools,
 * maximum iterations) plus the query. Generates
 * {@code check ctx.runDurableAgent(<query>, systemPrompt = {...}, model = <m>, tools = [...]);}.
 *
 * @since 1.8.0
 */
public class DurableAgentRunBuilder extends CallBuilder {

    public static final String QUERY_KEY = "query";
    public static final String CONTEXT_KEY = "context";
    public static final String SYSTEM_PROMPT_KEY = "systemPrompt";
    public static final String MODEL_KEY = "model";
    public static final String TOOLS_KEY = "tools";
    public static final String MAX_ITER_KEY = "maxIter";
    public static final String VERBOSE_KEY = "verbose";

    // Named-argument order in the generated call: agent identity first, limits last.
    private static final List<String> NAMED_ARG_ORDER =
            List.of(SYSTEM_PROMPT_KEY, MODEL_KEY, TOOLS_KEY, MAX_ITER_KEY, VERBOSE_KEY, CONTEXT_KEY);

    private static final String STRING_TYPE = "string";
    private static final String SYSTEM_PROMPT_TYPE = "ai:SystemPrompt";
    private static final String MODEL_TYPE = "ai:ModelProvider";
    private static final String TOOLS_TYPE = "(ai:BaseToolKit|ai:ToolConfig|ai:FunctionTool)[]";

    @Override
    protected NodeKind getFunctionNodeKind() {
        return NodeKind.DURABLE_AGENT_RUN;
    }

    @Override
    protected FunctionData.Kind getFunctionResultKind() {
        return FunctionData.Kind.FUNCTION;
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

        boolean fallbackTemplate = false;
        try {
            ModuleInfo workflowModuleInfo = new ModuleInfo(WORKFLOW_ORG, WORKFLOW_MODULE, WORKFLOW_MODULE, null);
            FunctionData functionData = new FunctionDataBuilder()
                    .name(RUN_DURABLE_AGENT_METHOD_NAME)
                    .moduleInfo(workflowModuleInfo)
                    .parentSymbolType(AGENT_CONTEXT_CLASS_NAME)
                    .functionResultKind(FunctionData.Kind.FUNCTION)
                    .project(PackageUtil.loadProject(context.workspaceManager(), context.filePath()))
                    .userModuleInfo(moduleInfo)
                    .workspaceManager(context.workspaceManager())
                    .filePath(context.filePath())
                    .build();

            if (functionData == null || functionData.parameters() == null || functionData.parameters().isEmpty()) {
                fallbackTemplate = true;
            } else {
                // The `context` parameter is reserved (a caller-provided ai:Context cannot cross
                // the durable activity boundary today) — keep the form focused on the agent config.
                LinkedHashMap<String, ParameterData> params = new LinkedHashMap<>(functionData.parameters());
                params.remove(CONTEXT_KEY);
                functionData.setParameters(params);

                Module module = context.workspaceManager().module(context.filePath()).orElse(null);
                setParameterProperties(functionData, module);
            }
        } catch (RuntimeException e) {
            // runDurableAgent may not be resolvable yet (module not pulled); fall back to a
            // stable static form so the node still opens.
            fallbackTemplate = true;
        }

        if (fallbackTemplate) {
            setFallbackProperties();
        }

        convertModelToSelect(context);
        properties().checkError(true);
    }

    // Static form used when the workflow module signature is unavailable.
    private void setFallbackProperties() {
        addCustomProperty(QUERY_KEY, "Query", "The initial user query; when omitted the agent waits for the "
                + "first chat event", STRING_TYPE, false, "");
        addCustomProperty(SYSTEM_PROMPT_KEY, "System Prompt", "The system prompt assigned to the agent",
                SYSTEM_PROMPT_TYPE, true, "{role: \"\", instructions: \"\"}");
        addCustomProperty(MODEL_KEY, "Model", "The model provider used for the agent's LLM calls",
                MODEL_TYPE, true, "");
        addCustomProperty(TOOLS_KEY, "Tools", "The AI tools available to the agent",
                TOOLS_TYPE, false, "[]");
        addCustomProperty(MAX_ITER_KEY, "Maximum Iterations", "Maximum LLM reasoning iterations per turn",
                "int", false, "");
    }

    private void addCustomProperty(String key, String label, String doc, String ballerinaType, boolean required,
                                   String value) {
        properties().custom()
                .metadata()
                    .label(label)
                    .description(doc)
                    .stepOut()
                .type(Property.ValueType.EXPRESSION, ballerinaType)
                .codedata()
                    .kind(required ? ParameterData.Kind.REQUIRED.name() : ParameterData.Kind.DEFAULTABLE.name())
                    .originalName(key)
                    .stepOut()
                .value(value)
                .editable(true)
                .optional(!required)
                .stepOut()
                .addProperty(key);
    }

    // The model is selected from the module-level `ai:ModelProvider` variables of the project
    // (typically the shared `wso2ModelProvider` created with the agent). Rebuilding the property
    // on its existing key keeps its position in the form.
    private void convertModelToSelect(TemplateContext context) {
        Map<String, Property> props = properties().build();
        Property model = props.get(MODEL_KEY);
        if (model == null) {
            return;
        }
        List<Option> options = getModelProviderVariables(context);
        String label = model.metadata() != null && model.metadata().label() != null
                ? model.metadata().label() : "Model";
        String doc = model.metadata() != null && model.metadata().description() != null
                ? model.metadata().description() : "The model provider used for the agent's LLM calls";
        String value = model.value() == null ? "" : model.value().toString();
        properties().custom()
                .metadata()
                    .label(label)
                    .description(doc)
                    .stepOut()
                .type()
                    .fieldType(Property.ValueType.SINGLE_SELECT)
                    .ballerinaType(MODEL_TYPE)
                    .options(options)
                    .selected(true)
                    .stepOut()
                .codedata()
                    .kind(ParameterData.Kind.REQUIRED.name())
                    .originalName(MODEL_KEY)
                    .stepOut()
                .value(value)
                .editable(true)
                .stepOut()
                .addProperty(MODEL_KEY);
    }

    private List<Option> getModelProviderVariables(TemplateContext context) {
        List<Option> options = new ArrayList<>();
        try {
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
        } catch (RuntimeException e) {
            // Project resolution failures leave the dropdown empty; the field is still editable.
        }
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

    @Override
    public Map<Path, List<TextEdit>> toSource(SourceBuilder sourceBuilder) {
        String ctxParamName = WorkflowUtil.resolveAgentContextParamName(sourceBuilder);

        String systemPrompt = requireValue(sourceBuilder, SYSTEM_PROMPT_KEY,
                "A system prompt is required to run the agent");
        String model = requireValue(sourceBuilder, MODEL_KEY,
                "A model provider is required to run the agent");

        List<String> callArgs = new ArrayList<>();
        Optional<Property> queryProperty = sourceBuilder.getProperty(QUERY_KEY);
        String query = queryProperty
                .filter(p -> p.value() != null && !p.value().toString().isEmpty())
                .map(Property::toSourceCode)
                .orElse("");
        if (!query.isEmpty()) {
            callArgs.add(query);
        }
        callArgs.add(SYSTEM_PROMPT_KEY + " = " + systemPrompt);
        callArgs.add(MODEL_KEY + " = " + model);
        for (String key : NAMED_ARG_ORDER) {
            if (SYSTEM_PROMPT_KEY.equals(key) || MODEL_KEY.equals(key)) {
                continue;
            }
            sourceBuilder.getProperty(key).ifPresent(p -> {
                String source = p.toSourceCode();
                if (source != null && !source.isEmpty() && !isEmptyToolsList(key, source)) {
                    callArgs.add(key + " = " + source);
                }
            });
        }

        sourceBuilder.token()
                .keyword(SyntaxKind.CHECK_KEYWORD)
                .name(ctxParamName)
                .keyword(SyntaxKind.DOT_TOKEN)
                .name(RUN_DURABLE_AGENT_METHOD_NAME)
                .keyword(SyntaxKind.OPEN_PAREN_TOKEN)
                .name(String.join(", ", callArgs))
                .keyword(SyntaxKind.CLOSE_PAREN_TOKEN)
                .endOfStatement();

        return sourceBuilder
                .textEdit()
                .acceptImport(WORKFLOW_ORG, WORKFLOW_MODULE)
                .build();
    }

    // The tools list defaults to []; omit the argument entirely when the user left it empty.
    private static boolean isEmptyToolsList(String key, String source) {
        return TOOLS_KEY.equals(key) && source.replaceAll("\\s", "").equals("[]");
    }

    private static String requireValue(SourceBuilder sourceBuilder, String key, String message) {
        return sourceBuilder.getProperty(key)
                .filter(p -> p.value() != null && !p.value().toString().isEmpty())
                .map(Property::toSourceCode)
                .orElseThrow(() -> new IllegalStateException(message));
    }
}
