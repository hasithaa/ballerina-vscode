/**
 * Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com) All Rights Reserved.
 *
 * WSO2 LLC. licenses this file to you under the Apache License,
 * Version 2.0 (the "License"); you may not use this file except
 * in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { useEffect, useRef, useState } from "react";
import styled from "@emotion/styled";
import { useRpcContext } from "@wso2/ballerina-rpc-client";
import { NodeList, Category as PanelCategory, FormField, FormImports, FormValues } from "@wso2/ballerina-side-panel";
import {
    AvailableNode,
    Category,
    CodeData,
    DIRECTORY_MAP,
    EVENT_TYPE,
    FlowNode,
    LineRange,
    MACHINE_VIEW,
    NodeProperties,
    ParentPopupData,
    Property,
    RecordTypeField,
    ToolParameters,
    ToolParametersValue,
    getPrimaryInputType,
} from "@wso2/ballerina-core";
import { cloneDeep } from "lodash";

import { convertBICategoriesToSidePanelCategories, convertConfig } from "../../../utils/bi";
import { getImportsForProperty } from "../../../utils/bi";
import ArtifactForm from "../Forms/ArtifactForm";
import { RelativeLoader } from "../../../components/RelativeLoader";
import { createDefaultParameterValue, createToolParameters, HIDDEN_TOOL_NODE_PROPERTY_KEYS } from "../AIChatAgent/formUtils";
import { REMOTE_ACTION_CALL, RESOURCE_ACTION_CALL } from "../../../constants";

/** Value the user entered for each action parameter, keyed by parameter name — becomes the call args. */
export type ActivityCallArgs = Record<string, string>;

const LoaderContainer = styled.div`
    display: flex;
    justify-content: center;
    align-items: center;
    height: 100%;
`;

const ImplementationBadge = styled.div`
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background-color: var(--vscode-input-background);
    border: 1px solid var(--vscode-editorWidget-border);
    border-radius: 4px;
    padding: 6px 10px;
    font-size: 12px;
    color: var(--vscode-foreground);
    margin-bottom: 4px;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
`;

const NoticeBanner = styled.div`
    display: flex;
    gap: 8px;
    background-color: var(--vscode-inputValidation-warningBackground);
    border: 1px solid var(--vscode-inputValidation-warningBorder);
    border-radius: 4px;
    padding: 8px 10px;
    margin: 8px 12px 0;
    font-size: 12px;
    line-height: 1.4;
    color: var(--vscode-foreground);
`;

enum PanelView {
    CONNECTION_LIST = "CONNECTION_LIST",
    ACTIVITY_FORM = "ACTIVITY_FORM",
}

const INITIAL_FIELDS: FormField[] = [
    {
        key: `name`,
        label: "Activity Name",
        type: "IDENTIFIER",
        optional: false,
        editable: true,
        documentation: "Enter a unique name for the activity.",
        value: "",
        types: [{ fieldType: "IDENTIFIER", scope: "Global", selected: false }],
        enabled: true,
    },
    {
        key: `description`,
        label: "Description",
        type: "TEXTAREA",
        optional: true,
        editable: true,
        documentation: "Describe what this activity does.",
        value: "",
        types: [{ fieldType: "STRING", selected: false }],
        enabled: true,
    },
];

interface NewActivityFromConnectionProps {
    /** Path of the file the workflow diagram is rendered for. The activity is added to this file. */
    fileName: string;
    /**
     * Position in the workflow function where the activity call will be added. Used as the expression
     * editor's scope so the action-parameter fields suggest the workflow function's local variables.
     */
    targetLineRange?: LineRange;
    /**
     * Called after the activity function is generated. `callArgs` maps each activity parameter name to
     * the expression the user entered, so the caller can insert the {@code callActivity} into the
     * workflow without a second form.
     */
    onActivityCreated: (activityName: string, callArgs: ActivityCallArgs) => void;
    /** Navigate back to the activity list (from the connection list). */
    onBack?: () => void;
    /** Close the side panel. */
    onClose?: () => void;
}

/**
 * Panel for creating a workflow activity from an existing connection. The user picks a connection
 * (or creates one), selects one of its actions, and fills a single form: the action's parameters as
 * normal expression fields (referencing workflow-local variables) plus the activity name, description,
 * and return type. On save the backend generates a `@workflow:Activity` passthrough wrapper — the
 * action's parameters become the activity's parameters and are passed straight to the action, closing
 * over the module-level connection — and the expressions the user entered are handed back as the
 * {@code callActivity} arguments.
 */
export function NewActivityFromConnection(props: NewActivityFromConnectionProps): JSX.Element {
    const { fileName, targetLineRange, onActivityCreated, onBack, onClose } = props;
    const { rpcClient } = useRpcContext();

    // Scope for the expression editors: the workflow position the activity call is added at, so the
    // action-parameter fields suggest the workflow function's local variables. Falls back to file start.
    const formTargetLineRange = targetLineRange ?? {
        startLine: { line: 0, offset: 0 },
        endLine: { line: 0, offset: 0 },
    };

    const [panelView, setPanelView] = useState<PanelView>(PanelView.CONNECTION_LIST);
    const [categories, setCategories] = useState<PanelCategory[]>([]);
    const [fields, setFields] = useState<FormField[]>(INITIAL_FIELDS);
    const [recordTypeFields, setRecordTypeFields] = useState<RecordTypeField[]>([]);
    const [loading, setLoading] = useState<boolean>(false);
    const [saving, setSaving] = useState<boolean>(false);
    // Set when the action's return type can't be determined (contains object/stream/etc.); the form
    // then shows a warning and lets the user pick the return type.
    const [showReturnTypeWarning, setShowReturnTypeWarning] = useState<boolean>(false);
    // Labels of parameters whose type isn't anydata (surfaced as anydata with a warning).
    const [nonDataParamNames, setNonDataParamNames] = useState<string[]>([]);

    const flowNodeRef = useRef<FlowNode>(null);
    const selectedNodeRef = useRef<AvailableNode>(undefined);
    const isSelectingNodeRef = useRef<boolean>(false);
    // The action's parameters (name + type) surfaced in the form; each becomes an activity parameter.
    const actionParamsRef = useRef<{ key: string; type: string }[]>([]);
    // Resolved return-type category/type from the LS signal; used as a fallback for the return type.
    const returnTypeInfoRef = useRef<{ kind?: string; type?: string } | undefined>(undefined);

    useEffect(() => {
        fetchConnections();
    }, []);

    // When the "Add Connection" wizard (launched from the connection list) finishes, a new global
    // connection has been written to connections.bal — refresh the list so it appears.
    useEffect(() => {
        rpcClient.onParentPopupSubmitted((parent: ParentPopupData) => {
            if (parent.artifactType === DIRECTORY_MAP.CONNECTION) {
                fetchConnections();
            }
        });
    }, [rpcClient]);

    // Launch the standard (global) connection-creation wizard, mirroring the AI agent tool flow.
    // The connection is created in connections.bal; the popup-submitted effect refreshes the list.
    const handleAddConnection = () => {
        rpcClient.getVisualizerRpcClient().openView({
            type: EVENT_TYPE.OPEN_VIEW,
            location: {
                view: MACHINE_VIEW.AddConnectionWizard,
                documentUri: fileName,
            },
            isPopup: true,
        });
    };

    const fetchConnections = async () => {
        setLoading(true);
        try {
            const response = await rpcClient.getBIDiagramRpcClient().getAvailableNodes({
                position: { line: 0, offset: 0 },
                filePath: fileName,
                // Ask the LS to tag each action with `agentToolCompatible` (all params + return are
                // anydata) so we can detect non-data actions when one is selected.
                queryMap: { checkAgentToolCompatibility: "true" },
            });
            if (!response.categories) {
                console.error(">>> Error getting available nodes", response);
                return;
            }
            const connectionsCategory = response.categories.filter(
                (item) => item.metadata.label === "Connections"
            ) as Category[];
            // remove connections which names start with _ underscore
            if (connectionsCategory.at(0)?.items) {
                connectionsCategory.at(0).items = connectionsCategory
                    .at(0)
                    .items.filter((item) => !item.metadata.label.startsWith("_"));
            }
            setCategories(convertBICategoriesToSidePanelCategories(connectionsCategory));
        } catch (error) {
            console.error(">>> Error fetching connections", { error });
            await rpcClient.getCommonRpcClient().showErrorMessage({
                message: "Failed to load connections.",
            });
        } finally {
            setLoading(false);
        }
    };

    const extractRecordTypeFields = (properties: NodeProperties): RecordTypeField[] => {
        return Object.entries(properties)
            .filter(([, property]) => {
                const primaryInputType = getPrimaryInputType(property?.types);
                return (
                    primaryInputType?.typeMembers &&
                    primaryInputType?.typeMembers.some((member) => member.kind === "RECORD_TYPE")
                );
            })
            .map(([key, property]) => ({
                key,
                property,
                recordTypeMembers: getPrimaryInputType(property?.types)?.typeMembers.filter(
                    (member) => member.kind === "RECORD_TYPE"
                ),
            }));
    };

    const getImplementationString = (codeData: CodeData | undefined): string => {
        if (!codeData) {
            return "";
        }
        switch (codeData.node) {
            case RESOURCE_ACTION_CALL:
                return `${codeData.parentSymbol} -> ${codeData.symbol} ${codeData.resourcePath}`;
            case REMOTE_ACTION_CALL:
                return `${codeData.parentSymbol} -> ${codeData.symbol}`;
            default:
                return "";
        }
    };

    const handleOnSelectNode = async (nodeId: string, metadata?: any) => {
        if (isSelectingNodeRef.current) {
            return;
        }
        if (nodeId !== REMOTE_ACTION_CALL && nodeId !== RESOURCE_ACTION_CALL) {
            console.warn(">>> Only remote and resource actions can be wrapped as activities", { nodeId });
            return;
        }
        isSelectingNodeRef.current = true;
        setLoading(true);
        try {
            const nodeTemplate = await rpcClient.getBIDiagramRpcClient().getNodeTemplate({
                position: { line: 0, offset: 0 },
                filePath: fileName,
                id: metadata.node.codedata,
            });
            if (!nodeTemplate.flowNode) {
                console.error(">>> Node template flowNode not found");
                return;
            }
            // Remove imports from optional+advanced properties to avoid unnecessary imports in genActivity
            if (nodeTemplate.flowNode.properties) {
                for (const key of Object.keys(nodeTemplate.flowNode.properties)) {
                    const prop = (nodeTemplate.flowNode.properties as Record<string, any>)[key];
                    if (prop.optional && prop.advanced && prop.imports) {
                        delete prop.imports;
                    }
                }
            }
            flowNodeRef.current = nodeTemplate.flowNode;
            selectedNodeRef.current = metadata.node;

            // Return-type category from the per-action LS signal drives the return-type field:
            //  - "dependent": databinding-style selector (the action infers the return from a typedesc)
            //  - "anydata": read-only field showing the concrete return type
            //  - "undeterminable": editable selector + warning (return contains object/stream/etc.)
            const returnTypeInfo = (metadata?.node as AvailableNode)?.codedata?.data?.returnTypeInfo as
                | { kind?: string; type?: string }
                | undefined;
            returnTypeInfoRef.current = returnTypeInfo;
            setShowReturnTypeWarning(returnTypeInfo?.kind === "undeterminable");

            const rawFields = nodeTemplate.flowNode.properties ? convertConfig(nodeTemplate.flowNode.properties) : [];
            const actionParams: { key: string; type: string }[] = [];
            const paramFields: FormField[] = [];
            let returnField: FormField | undefined;
            // Parameters whose type isn't anydata (from the LS signal): a workflow activity parameter
            // must be serializable, so we surface them as `anydata` and warn the user to fix the
            // generated activity afterwards.
            const nonDataParams: string[] = ((metadata?.node as AvailableNode)?.codedata?.data
                ?.nonDataParams as string[]) || [];
            const nonDataLabels: string[] = [];
            for (const field of rawFields) {
                // Internal properties (connection/checkError/variable/resourcePath) and the type-infer
                // parameter are not shown; they are kept in the flow node for source generation.
                if (HIDDEN_TOOL_NODE_PROPERTY_KEYS.includes(field.key) || field.codedata?.kind === "PARAM_FOR_TYPE_INFER") {
                    continue;
                }
                const primary = getPrimaryInputType(field.types);
                if (field.key === "type" || primary?.fieldType === "TYPE") {
                    returnField = field;
                    continue;
                }
                // Action parameter: a normal expression field the user fills with workflow-local values.
                // Use the canonical EXPRESSION type (e.g. http:RequestMessage) for the activity parameter
                // rather than the editor type (e.g. mime:Entity[]), which may need an extra import.
                const isNonData = nonDataParams.includes(field.key);
                const paramType = isNonData
                    ? "anydata"
                    : field.types?.find((t) => t.fieldType === "EXPRESSION")?.ballerinaType ||
                      primary?.ballerinaType ||
                      "";
                if (isNonData) {
                    nonDataLabels.push(field.label || field.key);
                }
                paramFields.push({
                    ...field,
                    value: typeof field.value === "string" ? field.value.replace(/^\$/, "") : field.value,
                    documentation:
                        (field.documentation || "") +
                        (isNonData
                            ? " ⚠ Not a data type — set to anydata; adjust this parameter's type in the" +
                              " generated activity afterwards."
                            : ""),
                });
                actionParams.push({ key: field.key, type: paramType });
            }
            actionParamsRef.current = actionParams;
            setNonDataParamNames(nonDataLabels);

            if (returnField) {
                if (returnTypeInfo?.kind === "anydata") {
                    returnField = {
                        ...returnField,
                        value: returnTypeInfo.type || returnField.value,
                        editable: false,
                        documentation: "The data type this activity returns.",
                    };
                } else if (returnTypeInfo?.kind === "undeterminable") {
                    // The action's return type is not a data type (object/stream/…), so it cannot be
                    // used as the activity's return type as-is. Default to json — a safe serializable
                    // choice — and let the user pick the actual type.
                    returnField = {
                        ...returnField,
                        value: "json",
                        editable: true,
                        documentation: "We cannot determine the return type — defaulted to json. " +
                            "Select the type this activity returns.",
                    };
                } else {
                    returnField = {
                        ...returnField,
                        editable: true,
                        documentation: "The data type this activity returns.",
                    };
                }
            }

            const templateDescription = (nodeTemplate.flowNode?.metadata?.description || "")
                .replace(/```[\s\S]*?```/g, "")
                .trim();
            const baseFields = INITIAL_FIELDS.map((field) =>
                field.key === "description" ? { ...field, value: templateDescription } : field
            );
            setRecordTypeFields(
                nodeTemplate.flowNode.properties ? extractRecordTypeFields(nodeTemplate.flowNode.properties) : []
            );
            setFields([...baseFields, ...paramFields, ...(returnField ? [returnField] : [])]);
            setPanelView(PanelView.ACTIVITY_FORM);
        } catch (error) {
            console.error(">>> Error fetching node template", error);
        } finally {
            setLoading(false);
            isSelectingNodeRef.current = false;
        }
    };

    const handleActivitySubmit = async (data: FormValues, formImports?: FormImports) => {
        const name = data["name"] || "";
        const cleanName = name.trim().replace(/[^a-zA-Z0-9]/g, "") || "newActivity";
        if (data.description) {
            data.description = data.description.replace(/```[\s\S]*?```/g, "").replace(/\n/g, " ").trim();
        }

        const clonedFlowNode = flowNodeRef.current ? cloneDeep(flowNodeRef.current) : null;
        if (!clonedFlowNode) {
            console.error(">>> Node template not found");
            return;
        }
        const newProperties = { ...(clonedFlowNode.properties || {}) } as Record<string, Property>;

        // Each filled action parameter becomes an activity parameter (passthrough): the activity
        // signature takes `<type> <name>`, the body passes `<name>` to the action, and the expression
        // the user entered becomes the callActivity argument for `<name>`.
        const activityParameters: ToolParameters = createToolParameters();
        activityParameters.metadata = { label: "Parameters", description: "Activity function parameters" };
        const parametersValue = activityParameters.value as ToolParametersValue;
        const callArgs: ActivityCallArgs = {};

        for (const { key, type } of actionParamsRef.current) {
            const property = newProperties[key];
            const userExpr = data[key];
            const filled = userExpr !== undefined && String(userExpr) !== "";
            const required = property ? property.optional === false : true;
            if (!filled && !required) {
                // Optional parameter left blank: not an activity parameter; the action uses its default.
                continue;
            }
            parametersValue[key] = createDefaultParameterValue({ value: key, type });
            if (filled) {
                callArgs[key] = String(userExpr);
            }
            // Path parameters are referenced by name inside the resource path (not passed as arguments),
            // so leave their property untouched. Every other parameter passes its name to the action.
            const kind = property?.codedata?.kind;
            const isPathParam = kind === "PATH_PARAM" || kind === "PATH_REST_PARAM";
            if (property && !isPathParam) {
                newProperties[key] = { ...property, value: key };
            }
        }

        // Return type chosen/derived in the form (fall back to the LS-resolved type for the read-only
        // anydata case, where the field value may not be submitted). Write it into both `type` (the
        // result variable type) and `targetType` (the type-infer param genActivity resolves the return
        // from) — for dependent actions genActivity reads targetType, so setting only `type` is ignored.
        // Undeterminable signatures (object/stream/…) are never used as a fallback — json is the
        // default the form seeds in that case.
        const returnType = data["type"]
            ?? (returnTypeInfoRef.current?.kind === "anydata" ? returnTypeInfoRef.current?.type : undefined);
        if (returnType !== undefined && returnType !== "") {
            if (newProperties["type"]) {
                newProperties["type"] = { ...newProperties["type"], value: String(returnType) };
            }
            if (newProperties["targetType"]) {
                newProperties["targetType"] = { ...newProperties["targetType"], value: String(returnType) };
            }
        }

        // Merge the parameter/return type imports onto the type property so genActivity emits them.
        if (formImports) {
            const merged: Record<string, string> = {};
            for (const { key } of [...actionParamsRef.current, { key: "type" }]) {
                const imports = getImportsForProperty(key, formImports);
                if (imports) {
                    for (const [prefix, moduleId] of Object.entries(imports)) {
                        merged[prefix] = moduleId.replace(/:[^/]+$/, "");
                    }
                }
            }
            const targetKey = newProperties["type"] ? "type" : Object.keys(newProperties)[0];
            if (Object.keys(merged).length > 0 && targetKey && newProperties[targetKey]) {
                newProperties[targetKey] = {
                    ...newProperties[targetKey],
                    imports: { ...newProperties[targetKey].imports, ...merged },
                };
            }
        }

        clonedFlowNode.properties = newProperties as NodeProperties;
        clonedFlowNode.codedata.isNew = true;
        clonedFlowNode.codedata.lineRange = {
            fileName: fileName.split(/[\\/]/).pop(),
            startLine: { line: 0, offset: 0 },
            endLine: { line: 0, offset: 0 },
        };

        setSaving(true);
        try {
            const response = await rpcClient.getBIDiagramRpcClient().genActivity({
                filePath: fileName,
                flowNode: clonedFlowNode,
                activityName: cleanName,
                description: data["description"] || "",
                connection: selectedNodeRef.current?.codedata?.parentSymbol || "",
                activityParameters,
            });
            if (response?.errorMsg) {
                console.error(">>> Error creating activity from connection", response);
                await rpcClient.getCommonRpcClient().showErrorMessage({
                    message: `Failed to create the activity '${cleanName}'. ${response.errorMsg}`,
                });
                return;
            }
            onActivityCreated(cleanName, callArgs);
        } catch (error) {
            console.error(">>> Error creating activity from connection", { error });
            await rpcClient.getCommonRpcClient().showErrorMessage({
                message: `Failed to create the activity '${cleanName}'.`,
            });
        } finally {
            setSaving(false);
        }
    };

    return (
        <>
            {(loading || saving) && (
                <LoaderContainer>
                    <RelativeLoader />
                </LoaderContainer>
            )}
            {!loading && !saving && panelView === PanelView.CONNECTION_LIST && (
                <NodeList
                    categories={categories}
                    onSelect={handleOnSelectNode}
                    onAddConnection={handleAddConnection}
                    onClose={onClose}
                    onBack={onBack}
                    title={"Connections"}
                    searchPlaceholder={"Search connections"}
                    panelBodySx={{ height: "calc(100vh - 140px)" }}
                />
            )}
            {!saving && panelView === PanelView.ACTIVITY_FORM && showReturnTypeWarning && (
                <NoticeBanner>
                    We cannot determine the return type of this action (it contains object/stream types). Select the
                    return type below; the generated <code>return</code> statement may need adjusting to match it.
                </NoticeBanner>
            )}
            {!saving && panelView === PanelView.ACTIVITY_FORM && nonDataParamNames.length > 0 && (
                <NoticeBanner>
                    {nonDataParamNames.join(", ")} {nonDataParamNames.length > 1 ? "are" : "is"} not a data type and
                    {nonDataParamNames.length > 1 ? " have" : " has"} been set to <code>anydata</code>. Adjust the
                    parameter type(s) in the generated activity afterwards.
                </NoticeBanner>
            )}
            {!saving && panelView === PanelView.ACTIVITY_FORM && (
                <ArtifactForm
                    preserveFieldOrder={false}
                    fileName={fileName}
                    targetLineRange={formTargetLineRange}
                    fields={fields}
                    recordTypeFields={recordTypeFields}
                    onSubmit={handleActivitySubmit}
                    onBack={() => setPanelView(PanelView.CONNECTION_LIST)}
                    submitText={"Create Activity"}
                    helperPaneSide="left"
                    injectedComponents={[
                        {
                            component: (
                                <ImplementationBadge
                                    title={getImplementationString(selectedNodeRef.current?.codedata)}
                                >
                                    {selectedNodeRef.current?.metadata?.icon && (
                                        <img
                                            src={selectedNodeRef.current.metadata.icon}
                                            style={{ width: 14, height: 14 }}
                                            onError={(e) => {
                                                (e.target as HTMLImageElement).style.display = "none";
                                            }}
                                        />
                                    )}
                                    {getImplementationString(selectedNodeRef.current?.codedata)}
                                </ImplementationBadge>
                            ),
                            index: 0,
                        },
                    ]}
                />
            )}
        </>
    );
}

export default NewActivityFromConnection;
