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

package io.ballerina.flowmodelgenerator.core;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import io.ballerina.compiler.api.SemanticModel;
import io.ballerina.compiler.api.symbols.Symbol;
import io.ballerina.compiler.api.symbols.SymbolKind;
import io.ballerina.compiler.api.symbols.TypeSymbol;
import io.ballerina.compiler.api.symbols.VariableSymbol;
import io.ballerina.compiler.syntax.tree.SyntaxKind;
import io.ballerina.flowmodelgenerator.core.model.FlowNode;
import io.ballerina.flowmodelgenerator.core.model.NodeKind;
import io.ballerina.flowmodelgenerator.core.model.Property;
import io.ballerina.flowmodelgenerator.core.model.PropertyCodedata;
import io.ballerina.flowmodelgenerator.core.model.SourceBuilder;
import io.ballerina.flowmodelgenerator.core.model.node.ActivityBuilder;
import io.ballerina.flowmodelgenerator.core.utils.FileSystemUtils;
import io.ballerina.flowmodelgenerator.core.utils.FlowNodeUtil;
import io.ballerina.flowmodelgenerator.core.utils.ParamUtils;
import io.ballerina.modelgenerator.commons.CommonUtils;
import io.ballerina.modelgenerator.commons.ModuleInfo;
import io.ballerina.modelgenerator.commons.ParameterData;
import io.ballerina.projects.Document;
import org.ballerinalang.langserver.commons.workspace.WorkspaceManager;
import org.eclipse.lsp4j.Range;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Generates {@code @workflow:Activity} functions that wrap a connection action call, following the
 * built-in activity pattern: the connection is the first parameter of the activity function and the
 * action is invoked on that parameter. Mirrors {@link AgentsGenerator#genTool} which generates agent
 * tools closing over the module-level connection instead.
 *
 * @since 1.5.0
 */
public class ActivityGenerator {

    public static final String CONNECTION_PARAM_NAME = "connection";
    private static final String CONNECTION_PARAM_DOC = "Connection to invoke the action on";
    // Short, conventional name for the result variable inside the generated activity body.
    private static final String RESULT_VARIABLE = "result";
    // Fallback databinding type when the action's return type is ambiguous (see normalizeReturnType).
    private static final String DEFAULT_RETURN_TYPE = "json";
    private static final String ERROR_UNION_SUFFIX = "|error";

    private final Gson gson;
    private final SemanticModel semanticModel;
    private final ModuleInfo moduleInfo;

    public ActivityGenerator(SemanticModel semanticModel, ModuleInfo moduleInfo) {
        this.gson = new Gson();
        this.semanticModel = semanticModel;
        this.moduleInfo = moduleInfo;
    }

    /**
     * Generates an activity function wrapping the given connection action call.
     *
     * @param node               the action call flow node (REMOTE_ACTION_CALL or RESOURCE_ACTION_CALL template
     *                           with the argument values set)
     * @param activityName       name of the activity function to generate
     * @param activityParameters activity function parameters property node (REPEATABLE_PROPERTY)
     * @param connectionName     name of the module-level connection variable the action was selected from;
     *                           used only to resolve the connection parameter type
     * @param description        description of the activity (emitted as the doc comment)
     * @param filePath           path of the file to add the activity function to
     * @param workspaceManager   the workspace manager
     * @return the text edits to apply
     */
    public JsonElement genActivity(JsonElement node, String activityName, JsonElement activityParameters,
                                   String connectionName, String description, Path filePath,
                                   WorkspaceManager workspaceManager) {
        FlowNode flowNode = gson.fromJson(node, FlowNode.class);
        Property activityParams = gson.fromJson(activityParameters, Property.class);
        NodeKind nodeKind = flowNode.codedata().node();
        if (nodeKind != NodeKind.REMOTE_ACTION_CALL && nodeKind != NodeKind.RESOURCE_ACTION_CALL) {
            throw new IllegalStateException("Unsupported node kind to generate an activity: " + nodeKind);
        }

        SourceBuilder sourceBuilder = new SourceBuilder(flowNode, workspaceManager, filePath);
        sourceBuilder.acceptImport(Constants.Workflow.WORKFLOW_ORG, Constants.Workflow.WORKFLOW_MODULE);

        Set<String> ignoredKeys = new HashSet<>(List.of(Property.VARIABLE_KEY, Property.TYPE_KEY,
                AgentsGenerator.TARGET_TYPE, Property.CONNECTION_KEY, Property.CHECK_ERROR_KEY));
        Set<String> pathParams = Set.of();
        if (nodeKind == NodeKind.RESOURCE_ACTION_CALL) {
            ignoredKeys.add(Property.RESOURCE_PATH_KEY);
            pathParams = collectPathParams(flowNode, ignoredKeys);
        }

        // Documentation: description, connection parameter, activity inputs, return value
        boolean hasDescription = AgentsGenerator.genDescription(description, sourceBuilder);
        if (hasDescription) {
            sourceBuilder.token().parameterDoc(CONNECTION_PARAM_NAME, CONNECTION_PARAM_DOC);
        }
        List<String> paramList = new ArrayList<>();
        paramList.add(resolveConnectionType(connectionName) + " " + CONNECTION_PARAM_NAME);
        paramList.addAll(AgentsGenerator.populateToolParams(activityParams, hasDescription, sourceBuilder));

        Optional<Property> optReturnType = sourceBuilder.getProperty(Property.TYPE_KEY);
        String returnType = "";
        if (optReturnType.isPresent()) {
            Property returnProperty = optReturnType.get();
            returnType = normalizeReturnType(
                    AgentsGenerator.resolveReturnType(flowNode, returnProperty, sourceBuilder));
            if (hasDescription) {
                sourceBuilder.token().returnDoc(returnProperty.metadata().description());
            }
        }
        boolean hasCheckError = FlowNodeUtil.hasCheckKeyFlagSet(flowNode);

        // Annotation and signature
        String icon = flowNode.metadata().icon();
        sourceBuilder.token()
                .name(ActivityBuilder.ACTIVITY_ANNOTATION)
                .name(System.lineSeparator())
                .name("@display {label: \"\", iconPath: \"")
                .name(icon == null ? "" : icon)
                .name("\"}")
                .name(System.lineSeparator());
        sourceBuilder.token().keyword(SyntaxKind.ISOLATED_KEYWORD).keyword(SyntaxKind.FUNCTION_KEYWORD);
        sourceBuilder.token().name(activityName).keyword(SyntaxKind.OPEN_PAREN_TOKEN);
        sourceBuilder.token().name(String.join(", ", paramList));
        sourceBuilder.token().keyword(SyntaxKind.CLOSE_PAREN_TOKEN);

        if (!returnType.isEmpty()) {
            sourceBuilder.token().keyword(SyntaxKind.RETURNS_KEYWORD).name(returnType);
            if (hasCheckError) {
                sourceBuilder.token().keyword(SyntaxKind.PIPE_TOKEN).keyword(SyntaxKind.ERROR_KEYWORD);
            }
        } else if (hasCheckError) {
            sourceBuilder.token().keyword(SyntaxKind.RETURNS_KEYWORD).name("error?");
        }

        // Body: invoke the action on the connection parameter. Use a short, fixed result variable
        // name ("result") since it is local to the generated function body.
        sourceBuilder.token().keyword(SyntaxKind.OPEN_BRACE_TOKEN);
        if (!returnType.isEmpty()) {
            sourceBuilder.token()
                    .name(returnType)
                    .whiteSpace()
                    .name(RESULT_VARIABLE)
                    .whiteSpace()
                    .keyword(SyntaxKind.EQUAL_TOKEN);
        }
        if (hasCheckError) {
            sourceBuilder.token().keyword(SyntaxKind.CHECK_KEYWORD);
        }

        if (nodeKind == NodeKind.REMOTE_ACTION_CALL) {
            sourceBuilder.token()
                    .name(CONNECTION_PARAM_NAME)
                    .keyword(SyntaxKind.RIGHT_ARROW_TOKEN)
                    .name(flowNode.metadata().label())
                    .stepOut()
                    .functionParameters(flowNode, ignoredKeys);
        } else {
            String resourcePath = resolveResourcePath(flowNode, pathParams);
            ignoredKeys.addAll(pathParams);
            sourceBuilder.token()
                    .name(CONNECTION_PARAM_NAME)
                    .keyword(SyntaxKind.RIGHT_ARROW_TOKEN)
                    .resourcePath(resourcePath)
                    .keyword(SyntaxKind.DOT_TOKEN)
                    .name(flowNode.codedata().symbol())
                    .stepOut()
                    .functionParameters(flowNode, ignoredKeys);
        }

        if (!returnType.isEmpty()) {
            sourceBuilder.token()
                    .keyword(SyntaxKind.RETURN_KEYWORD)
                    .name(RESULT_VARIABLE)
                    .endOfStatement();
        }
        sourceBuilder.token().keyword(SyntaxKind.CLOSE_BRACE_TOKEN);
        // Append the activity function at the end of the target file (after imports/existing
        // declarations) rather than at the action-call site — the flow node's line range points at
        // the selected action, which for a freshly picked action is line 0 (before the imports).
        Document targetDoc = FileSystemUtils.getDocument(workspaceManager, sourceBuilder.filePath);
        Range endOfFile = CommonUtils.toRange(targetDoc.syntaxTree().rootNode().lineRange().endLine());
        sourceBuilder.textEdit(SourceBuilder.SourceKind.DECLARATION, sourceBuilder.filePath, endOfFile);
        if (AgentsGenerator.needsModuleImport(flowNode, returnType, paramList)) {
            sourceBuilder.acceptImport();
        }
        return gson.toJsonTree(sourceBuilder.build());
    }

    /**
     * Normalizes the databinding/return type for the generated activity. The activity signature adds
     * {@code |error} separately and the body uses {@code check}, so the declared type must be the
     * success type; and when the action's return type is unspecified or ambiguous ({@code anydata} /
     * {@code any} / empty) we fall back to {@code json}.
     */
    private static String normalizeReturnType(String returnType) {
        if (returnType == null) {
            return DEFAULT_RETURN_TYPE;
        }
        String type = returnType.strip();
        if (type.endsWith(ERROR_UNION_SUFFIX)) {
            type = type.substring(0, type.length() - ERROR_UNION_SUFFIX.length()).strip();
        }
        if (type.isEmpty() || type.equals("anydata") || type.equals("any")) {
            return DEFAULT_RETURN_TYPE;
        }
        return type;
    }

    /**
     * Resolves the type of the module-level connection variable (e.g. {@code http:Client}) to use as
     * the type of the activity's connection parameter.
     */
    private String resolveConnectionType(String connectionName) {
        for (Symbol symbol : semanticModel.moduleSymbols()) {
            if (symbol.kind() != SymbolKind.VARIABLE) {
                continue;
            }
            if (symbol.getName().orElse("").equals(connectionName)) {
                TypeSymbol typeSymbol = ((VariableSymbol) symbol).typeDescriptor();
                return CommonUtils.getTypeSignature(semanticModel, typeSymbol, true, moduleInfo);
            }
        }
        throw new IllegalStateException("Connection '" + connectionName + "' is not found in the module");
    }

    private static Set<String> collectPathParams(FlowNode flowNode, Set<String> ignoredKeys) {
        Map<String, Property> properties = flowNode.properties();
        if (properties == null) {
            return Set.of();
        }
        Set<String> pathParams = new HashSet<>();
        for (Map.Entry<String, Property> entry : properties.entrySet()) {
            if (ignoredKeys.contains(entry.getKey()) || Property.RESOURCE_PATH_KEY.equals(entry.getKey())) {
                continue;
            }
            PropertyCodedata codedata = entry.getValue().codedata();
            if (codedata == null || codedata.kind() == null) {
                continue;
            }
            if (codedata.kind().equals(ParameterData.Kind.PATH_PARAM.name())
                    || codedata.kind().equals(ParameterData.Kind.PATH_REST_PARAM.name())) {
                // Keep the raw property key so it matches the flow node's property map (getProperty)
                // and the ignoredKeys set; any identifier escaping must happen only at render time.
                pathParams.add(entry.getKey());
            }
        }
        return pathParams;
    }

    private static String resolveResourcePath(FlowNode flowNode, Set<String> pathParams) {
        Property resourcePathProperty = flowNode.properties().get(Property.RESOURCE_PATH_KEY);
        String resourcePath = resourcePathProperty.codedata().originalName();
        if (resourcePath.equals(ParamUtils.REST_RESOURCE_PATH)) {
            resourcePath = resourcePathProperty.value().toString();
        }
        for (String key : pathParams) {
            Optional<Property> property = flowNode.getProperty(key);
            if (property.isEmpty() || property.get().codedata() == null) {
                continue;
            }
            if (property.get().codedata().kind().equals(ParameterData.Kind.PATH_REST_PARAM.name())) {
                resourcePath = resourcePath.replace(ParamUtils.REST_PARAM_PATH, property.get().value().toString());
            }
        }
        return resourcePath;
    }
}
