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

import { useCallback, useEffect, useRef, useState } from "react";
import styled from "@emotion/styled";
import { useRpcContext } from "@wso2/ballerina-rpc-client";
import { NodeList, Category as PanelCategory, FormField, FormImports, FormValues } from "@wso2/ballerina-side-panel";
import {
    AvailableNode,
    Category,
    CodeData,
    Diagnostic,
    DIRECTORY_MAP,
    EVENT_TYPE,
    FlowNode,
    MACHINE_VIEW,
    NodeProperties,
    ParentPopupData,
    Property,
    RecordTypeField,
    ToolParameterItem,
    ToolParameters,
    ToolParametersValue,
    getPrimaryInputType,
} from "@wso2/ballerina-core";
import { cloneDeep } from "lodash";

import {
    convertBICategoriesToSidePanelCategories,
    convertConfig,
    filterToolInputSymbolDiagnostics,
} from "../../../utils/bi";
import { getImportsForProperty } from "../../../utils/bi";
import ArtifactForm from "../Forms/ArtifactForm";
import { RelativeLoader } from "../../../components/RelativeLoader";
import {
    createDefaultParameterValue,
    createToolInputFields,
    createToolParameters,
    prepareToolInputFields,
} from "../AIChatAgent/formUtils";
import { updateResourcePathProperty } from "../AIChatAgent/agentTools";
import { REMOTE_ACTION_CALL, RESOURCE_ACTION_CALL } from "../../../constants";

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
    /** Called after the activity function is generated and applied. */
    onActivityCreated: (activityName: string) => void;
    /** Navigate back to the activity list (from the connection list). */
    onBack?: () => void;
    /** Close the side panel. */
    onClose?: () => void;
}

/**
 * Panel for creating a workflow activity from an existing connection. The user picks a connection,
 * selects one of its actions, and fills a form (activity name/description, activity inputs and the
 * action argument mapping). The backend generates a `@workflow:Activity` function wrapping the action
 * call with the connection as the first parameter (built-in activity pattern). Ported from the AI
 * agent "create tool from connection" flow.
 */
export function NewActivityFromConnection(props: NewActivityFromConnectionProps): JSX.Element {
    const { fileName, onActivityCreated, onBack, onClose } = props;
    const { rpcClient } = useRpcContext();

    const [panelView, setPanelView] = useState<PanelView>(PanelView.CONNECTION_LIST);
    const [categories, setCategories] = useState<PanelCategory[]>([]);
    const [fields, setFields] = useState<FormField[]>(INITIAL_FIELDS);
    const [recordTypeFields, setRecordTypeFields] = useState<RecordTypeField[]>([]);
    const [loading, setLoading] = useState<boolean>(false);
    const [saving, setSaving] = useState<boolean>(false);
    // True when the selected action has non-data (non-anydata) params/return; the form then shows a
    // notice and the activity is generated as a stub with an empty action call.
    const [showNonDataNotice, setShowNonDataNotice] = useState<boolean>(false);

    const flowNodeRef = useRef<FlowNode>(null);
    const selectedNodeRef = useRef<AvailableNode>(undefined);
    const parameterFieldsRef = useRef<ToolParameterItem[]>([]);
    const isSelectingNodeRef = useRef<boolean>(false);
    const isDataCompatibleRef = useRef<boolean>(true);

    // Suppress undefined-symbol diagnostics for expressions referencing activity input names
    const customDiagnosticFilter = useCallback((diagnostics: Diagnostic[]) => {
        if (!parameterFieldsRef.current || parameterFieldsRef.current.length === 0) {
            return diagnostics;
        }
        const activityInputs = parameterFieldsRef.current.map((param) => ({
            type: param.formValues.type,
            variable: param.formValues.variable,
        }));
        return filterToolInputSymbolDiagnostics(diagnostics, activityInputs);
    }, []);

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

            // An action is data-compatible when all its params and return type are anydata (the same
            // criterion the agent tool flow uses). Non-data actions can't be wrapped 1:1, so we show a
            // notice and generate a stub with an empty action call for the user to complete.
            const compatible =
                String((metadata?.node as AvailableNode)?.codedata?.data?.agentToolCompatible) !== "false";
            isDataCompatibleRef.current = compatible;
            setShowNonDataNotice(!compatible);

            const nodeParameterFields = nodeTemplate.flowNode.properties
                ? convertConfig(nodeTemplate.flowNode.properties)
                : [];
            const activityInputFields = createToolInputFields(prepareToolInputFields(nodeParameterFields));
            activityInputFields.forEach((field) => {
                if (field.key === "parameters") {
                    field.label = "Activity Inputs";
                    field.documentation = "Define the inputs to provide when calling this activity.";
                }
            });
            nodeParameterFields.forEach((field) => {
                if (getPrimaryInputType(field.types)?.fieldType === "TYPE") {
                    field.documentation = "The data type this activity returns.";
                }
            });

            const templateDescription = (nodeTemplate.flowNode?.metadata?.description || "")
                .replace(/```[\s\S]*?```/g, "")
                .trim();

            const baseFields = INITIAL_FIELDS.map((field) =>
                field.key === "description" ? { ...field, value: templateDescription } : field
            );
            // Non-data actions: show only name/description — the action call is generated empty and the
            // user fills in the logic, so the input/mapping fields would not map cleanly.
            setRecordTypeFields(
                compatible && nodeTemplate.flowNode.properties
                    ? extractRecordTypeFields(nodeTemplate.flowNode.properties)
                    : []
            );
            setFields(
                compatible
                    ? [
                          ...baseFields,
                          ...activityInputFields,
                          ...nodeParameterFields.map((field) => ({
                              ...field,
                              value: typeof field.value === "string" ? field.value.replace(/^\$/, "") : field.value,
                          })),
                      ]
                    : baseFields
            );
            setPanelView(PanelView.ACTIVITY_FORM);
        } catch (error) {
            console.error(">>> Error fetching node template", error);
        } finally {
            setLoading(false);
            isSelectingNodeRef.current = false;
        }
    };

    const buildActivityParameters = (params: ToolParameterItem[]): ToolParameters => {
        const activityParameters = createToolParameters();
        activityParameters.metadata = { label: "Parameters", description: "Activity function parameters" };
        const parametersValue = activityParameters.value as ToolParametersValue;
        for (const param of params ?? []) {
            const { variable, parameterDescription, type } = param.formValues;
            parametersValue[variable] = createDefaultParameterValue({
                value: variable,
                parameterDescription,
                type,
            });
        }
        return activityParameters;
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
        const nodeId = clonedFlowNode.codedata.node;
        const activityParameters = buildActivityParameters(data["parameters"] as ToolParameterItem[]);

        // Write the form values into the action call's properties
        if (clonedFlowNode.properties) {
            const newProperties = { ...clonedFlowNode.properties } as Record<string, Property>;
            Object.keys(newProperties).forEach((key) => {
                const paramValue = data[key];
                if (paramValue !== undefined && newProperties[key]) {
                    newProperties[key] = { ...newProperties[key], value: paramValue };
                }
                if (nodeId === RESOURCE_ACTION_CALL) {
                    const resourcePathProperty = newProperties["resourcePath"];
                    if (resourcePathProperty && paramValue !== undefined) {
                        newProperties["resourcePath"] = updateResourcePathProperty(
                            resourcePathProperty,
                            key,
                            paramValue
                        );
                    }
                }
            });
            clonedFlowNode.properties = newProperties as NodeProperties;
        }

        // Merge parameter type imports onto a flowNode property so genActivity includes them
        const paramImports = formImports ? getImportsForProperty("parameters", formImports) : undefined;
        if (paramImports && clonedFlowNode.properties) {
            const props = clonedFlowNode.properties as Record<string, Property>;
            const targetKey = props["type"] ? "type" : Object.keys(props)[0];
            if (targetKey && props[targetKey]) {
                // Strip version suffix to match the format the backend expects
                const cleanedImports: Record<string, string> = {};
                for (const [prefix, moduleId] of Object.entries(paramImports)) {
                    cleanedImports[prefix] = moduleId.replace(/:[^/]+$/, "");
                }
                props[targetKey].imports = { ...props[targetKey].imports, ...cleanedImports };
            }
        }

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
                // Non-data actions are generated as a stub with an empty action call.
                emptyActionArgs: !isDataCompatibleRef.current,
            });
            if (response?.errorMsg) {
                console.error(">>> Error creating activity from connection", response);
                await rpcClient.getCommonRpcClient().showErrorMessage({
                    message: `Failed to create the activity '${cleanName}'. ${response.errorMsg}`,
                });
                return;
            }
            onActivityCreated(cleanName);
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
            {!saving && panelView === PanelView.ACTIVITY_FORM && showNonDataNotice && (
                <NoticeBanner>
                    This action contains non-data types. The activity is created with an empty action call —
                    please edit the activity function logic to handle those types.
                </NoticeBanner>
            )}
            {!saving && panelView === PanelView.ACTIVITY_FORM && (
                <ArtifactForm
                    preserveFieldOrder={false}
                    fileName={fileName}
                    targetLineRange={{ startLine: { line: 0, offset: 0 }, endLine: { line: 0, offset: 0 } }}
                    fields={fields}
                    recordTypeFields={recordTypeFields}
                    onSubmit={handleActivitySubmit}
                    onBack={() => setPanelView(PanelView.CONNECTION_LIST)}
                    submitText={"Create Activity"}
                    helperPaneSide="left"
                    customDiagnosticFilter={customDiagnosticFilter}
                    onChange={(fieldKey, value) => {
                        if (fieldKey === "parameters") {
                            parameterFieldsRef.current = value as ToolParameterItem[];
                        }
                    }}
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
