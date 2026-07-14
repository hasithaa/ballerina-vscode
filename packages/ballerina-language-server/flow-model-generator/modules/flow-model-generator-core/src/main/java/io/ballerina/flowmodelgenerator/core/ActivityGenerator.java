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
 * Generates {@code @workflow:Activity} functions that wrap a connection action call. The connection is
 * a module-level global variable (created via the connection wizard) referenced by name in the activity
 * body; it is not a parameter of the activity function. Mirrors {@link AgentsGenerator#genTool}, which
 * generates agent tools closing over the module-level connection in the same way.
 *
 * @since 1.5.0
 */
public class ActivityGenerator {

    // Short, conventional name for the result variable inside the generated activity body.
    private static final String RESULT_VARIABLE = "result";
    // Name of the intermediate stream variable when the action's stream return is collected.
    private static final String STREAM_VARIABLE = "streamResult";
    // Fallback databinding type when the action's return type is ambiguous (see normalizeReturnType).
    private static final String DEFAULT_RETURN_TYPE = "json";
    private static final String ERROR_UNION_SUFFIX = "|error";

    private final Gson gson;
    private final SemanticModel semanticModel;

    public ActivityGenerator(SemanticModel semanticModel) {
        this.gson = new Gson();
        this.semanticModel = semanticModel;
    }

    /**
     * Generates an activity function wrapping the given connection action call.
     *
     * @param node               the action call flow node (REMOTE_ACTION_CALL or RESOURCE_ACTION_CALL template
     *                           with the argument values set)
     * @param activityName       name of the activity function to generate
     * @param activityParameters activity function parameters property node (REPEATABLE_PROPERTY)
     * @param connectionName     name of the module-level connection variable the action was selected from;
     *                           referenced by name in the generated activity body
     * @param description        description of the activity (emitted as the doc comment)
     * @param emptyActionArgs    when {@code true}, the wrapped action call is generated with no
     *                           arguments (used when the action has non-data types the user must
     *                           fill in manually)
     * @param streamElementType  when the action returns a stream, its element type {@code T}: the
     *                           body collects the stream and returns {@code T[]}; else null
     * @param filePath           path of the file to add the activity function to
     * @param workspaceManager   the workspace manager
     * @return the text edits to apply
     */
    public JsonElement genActivity(JsonElement node, String activityName, JsonElement activityParameters,
                                   String connectionName, String description, boolean emptyActionArgs,
                                   String streamElementType, Path filePath, WorkspaceManager workspaceManager) {
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

        // The connection is a module-level global referenced by name in the body (not a parameter);
        // validate it exists so a stale/deleted connection surfaces a clear error.
        validateConnectionExists(connectionName);

        // When the action has non-data types, generate the call with no arguments (a stub the user
        // completes): ignore every action property so no arguments are emitted for the call.
        if (emptyActionArgs && flowNode.properties() != null) {
            ignoredKeys.addAll(flowNode.properties().keySet());
        }

        // Documentation: description, activity inputs, return value
        boolean hasDescription = AgentsGenerator.genDescription(description, sourceBuilder);
        List<String> paramList = new ArrayList<>(
                AgentsGenerator.populateToolParams(activityParams, hasDescription, sourceBuilder));

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

        // Body: invoke the action on the module-level connection. Use a short, fixed result variable
        // name ("result") since it is local to the generated function body. When the action returns a
        // stream, the stream is collected into an array of its element type after the call.
        boolean collectStream = streamElementType != null && !streamElementType.isBlank();
        sourceBuilder.token().keyword(SyntaxKind.OPEN_BRACE_TOKEN);
        if (collectStream) {
            sourceBuilder.token()
                    .name("var")
                    .whiteSpace()
                    .name(STREAM_VARIABLE)
                    .whiteSpace()
                    .keyword(SyntaxKind.EQUAL_TOKEN);
        } else if (!returnType.isEmpty()) {
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
                    .name(connectionName)
                    .keyword(SyntaxKind.RIGHT_ARROW_TOKEN)
                    .name(flowNode.metadata().label())
                    .stepOut()
                    .functionParameters(flowNode, ignoredKeys);
        } else {
            String resourcePath = resolveResourcePath(flowNode, pathParams);
            ignoredKeys.addAll(pathParams);
            sourceBuilder.token()
                    .name(connectionName)
                    .keyword(SyntaxKind.RIGHT_ARROW_TOKEN)
                    .resourcePath(resourcePath)
                    .keyword(SyntaxKind.DOT_TOKEN)
                    .name(flowNode.codedata().symbol())
                    .stepOut()
                    .functionParameters(flowNode, ignoredKeys);
        }

        if (collectStream) {
            // <T>[] result = check from var item in streamResult select item; return result;
            sourceBuilder.token()
                    .name(streamElementType + "[]")
                    .whiteSpace()
                    .name(RESULT_VARIABLE)
                    .whiteSpace()
                    .keyword(SyntaxKind.EQUAL_TOKEN)
                    .keyword(SyntaxKind.CHECK_KEYWORD)
                    .name("from var item in " + STREAM_VARIABLE + " select item")
                    .endOfStatement()
                    .keyword(SyntaxKind.RETURN_KEYWORD)
                    .name(RESULT_VARIABLE)
                    .endOfStatement();
        } else if (!returnType.isEmpty()) {
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
     * Validates that the given connection name resolves to a module-level variable. The generated
     * activity body references the connection by name, so a missing connection must fail with a clear
     * error rather than producing a body that references an undefined symbol.
     */
    private void validateConnectionExists(String connectionName) {
        for (Symbol symbol : semanticModel.moduleSymbols()) {
            if (symbol.kind() != SymbolKind.VARIABLE) {
                continue;
            }
            if (symbol.getName().orElse("").equals(connectionName)) {
                return;
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
