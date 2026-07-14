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
import { Button, Codicon } from "@wso2/ui-toolkit";
import { useRpcContext } from "@wso2/ballerina-rpc-client";
import { NodeList, Category as PanelCategory, FormField, FormValues } from "@wso2/ballerina-side-panel";
import {
    ActivityActionAnalysis,
    AvailableNode,
    Category,
    CodeData,
    DIRECTORY_MAP,
    EVENT_TYPE,
    FlowNode,
    MACHINE_VIEW,
    NodeProperties,
    ParentPopupData,
    Property,
    ToolParameters,
    ToolParametersValue,
} from "@wso2/ballerina-core";
import { cloneDeep } from "lodash";

import { convertBICategoriesToSidePanelCategories } from "../../../utils/bi";
import ArtifactForm from "../Forms/ArtifactForm";
import { RelativeLoader } from "../../../components/RelativeLoader";
import { createDefaultParameterValue, createToolParameters } from "../AIChatAgent/formUtils";
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

const UnsupportedContainer = styled.div`
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px;
    font-size: 13px;
    line-height: 1.5;
    color: var(--vscode-foreground);
`;

const WarningBox = styled.div`
    display: flex;
    gap: 8px;
    background-color: var(--vscode-inputValidation-warningBackground);
    border: 1px solid var(--vscode-inputValidation-warningBorder);
    border-radius: 4px;
    padding: 10px;
`;

const ReasonList = styled.ul`
    margin: 4px 0 0 0;
    padding-left: 18px;
`;

enum PanelView {
    CONNECTION_LIST = "CONNECTION_LIST",
    ACTIVITY_FORM = "ACTIVITY_FORM",
    UNSUPPORTED = "UNSUPPORTED",
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

// The return-type field key. The action node's own `type` property key is also "type", so the derived
// value written on submit targets both this field and the flow node property.
const RETURN_TYPE_KEY = "type";

interface NewActivityFromConnectionProps {
    /** Path of the file the workflow diagram is rendered for. The activity is added to this file. */
    fileName: string;
    /** Called after the activity function is generated; the caller opens the call form for it. */
    onActivityCreated: (activityName: string) => void;
    /** Navigate back to the activity list (from the connection list). */
    onBack?: () => void;
    /** Close the side panel. */
    onClose?: () => void;
}

/**
 * "Create new Activity from Action" wizard. The user picks a connection (or creates one), selects one
 * of its actions, and gets a checkbox form: the action's parameters (derived by the LS — required ones
 * pre-selected and locked, optional ones selectable) and the derived return type. No expressions are
 * entered here. On create, the backend generates a `@workflow:Activity` passthrough wrapper (the
 * selected parameters become the activity's parameters, the connection is closed over, and a stream
 * return is collected into an array), and the caller then opens the normal callActivity form with the
 * new activity selected so the workflow data is wired there.
 *
 * When the action's signature cannot be wrapped automatically (non-data types, rest parameters, ...),
 * the wizard explains why and shows the manual steps instead.
 */
export function NewActivityFromConnection(props: NewActivityFromConnectionProps): JSX.Element {
    const { fileName, onActivityCreated, onBack, onClose } = props;
    const { rpcClient } = useRpcContext();

    const [panelView, setPanelView] = useState<PanelView>(PanelView.CONNECTION_LIST);
    const [categories, setCategories] = useState<PanelCategory[]>([]);
    const [fields, setFields] = useState<FormField[]>(INITIAL_FIELDS);
    const [loading, setLoading] = useState<boolean>(false);
    const [saving, setSaving] = useState<boolean>(false);
    const [unsupportedReasons, setUnsupportedReasons] = useState<string[]>([]);

    const flowNodeRef = useRef<FlowNode>(null);
    const selectedNodeRef = useRef<AvailableNode>(undefined);
    const analysisRef = useRef<ActivityActionAnalysis>(undefined);
    const isSelectingNodeRef = useRef<boolean>(false);

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
            const node = metadata.node as AvailableNode;
            selectedNodeRef.current = node;

            // The LS derives the activity signature from the action (required/optional params with
            // data types, return type, stream collection) or reports why it can't be wrapped.
            const analysisResponse = await rpcClient.getBIDiagramRpcClient().analyzeActivityAction({
                filePath: fileName,
                connection: node.codedata?.parentSymbol || "",
                actionName: node.codedata?.symbol || "",
                nodeKind: nodeId,
            });
            if (analysisResponse.errorMsg || !analysisResponse.analysis) {
                console.error(">>> Error analyzing the action", analysisResponse);
                await rpcClient.getCommonRpcClient().showErrorMessage({
                    message: `Failed to analyze the action '${node.codedata?.symbol}'.`,
                });
                return;
            }
            const analysis = analysisResponse.analysis;
            analysisRef.current = analysis;

            if (!analysis.supported) {
                setUnsupportedReasons(analysis.reasons || []);
                setPanelView(PanelView.UNSUPPORTED);
                return;
            }

            // The action node template carries the action call shape (resource path, arg slots) used
            // by the activity generation.
            const nodeTemplate = await rpcClient.getBIDiagramRpcClient().getNodeTemplate({
                position: { line: 0, offset: 0 },
                filePath: fileName,
                id: node.codedata,
            });
            if (!nodeTemplate.flowNode) {
                console.error(">>> Node template flowNode not found");
                return;
            }
            flowNodeRef.current = nodeTemplate.flowNode;

            const templateDescription = (nodeTemplate.flowNode?.metadata?.description || "")
                .replace(/```[\s\S]*?```/g, "")
                .trim();
            const baseFields = INITIAL_FIELDS.map((field) =>
                field.key === "description" ? { ...field, value: templateDescription } : field
            );

            // One checkbox per derived parameter: required ones are pre-selected and locked; optional
            // ones are selectable. The parameter name and derived type are shown read-only.
            const paramFields: FormField[] = (analysis.params || []).map((param) => ({
                key: param.name,
                label: param.name,
                type: "FLAG",
                optional: !param.required,
                editable: !param.required,
                documentation: param.required ? `${param.type} (required)` : param.type,
                value: param.required,
                types: [{ fieldType: "FLAG", selected: true }],
                enabled: true,
            }));

            const returnTypeField: FormField[] = analysis.returnType
                ? [
                      {
                          key: RETURN_TYPE_KEY,
                          label: "Return Type",
                          type: "TYPE",
                          optional: false,
                          editable: false,
                          documentation: analysis.streamElementType
                              ? "The action returns a stream; the activity collects it and returns an array."
                              : "The data type this activity returns.",
                          value: analysis.returnType,
                          types: [{ fieldType: "TYPE", selected: true }],
                          enabled: true,
                      },
                  ]
                : [];

            setFields([...baseFields, ...paramFields, ...returnTypeField]);
            setPanelView(PanelView.ACTIVITY_FORM);
        } catch (error) {
            console.error(">>> Error preparing the create-activity form", error);
        } finally {
            setLoading(false);
            isSelectingNodeRef.current = false;
        }
    };

    const handleActivitySubmit = async (data: FormValues) => {
        const name = data["name"] || "";
        const cleanName = name.trim().replace(/[^a-zA-Z0-9]/g, "") || "newActivity";
        if (data.description) {
            data.description = data.description.replace(/```[\s\S]*?```/g, "").replace(/\n/g, " ").trim();
        }
        const analysis = analysisRef.current;
        const clonedFlowNode = flowNodeRef.current ? cloneDeep(flowNodeRef.current) : null;
        if (!clonedFlowNode || !analysis) {
            console.error(">>> Node template or analysis not found");
            return;
        }

        // Selected parameters (required always; optional when checked) become the activity's
        // parameters, passed straight through to the action call.
        const selectedParams = (analysis.params || []).filter(
            (param) => param.required || data[param.name] === true
        );
        const activityParameters: ToolParameters = createToolParameters();
        activityParameters.metadata = { label: "Parameters", description: "Activity function parameters" };
        const parametersValue = activityParameters.value as ToolParametersValue;
        for (const param of selectedParams) {
            parametersValue[param.name] = createDefaultParameterValue({ value: param.name, type: param.type });
        }

        const selectedNames = new Set(selectedParams.map((param) => param.name));
        const newProperties = { ...(clonedFlowNode.properties || {}) } as Record<string, Property>;
        for (const param of analysis.params || []) {
            const property = newProperties[param.name];
            if (!property) {
                continue;
            }
            // Selected: pass the activity parameter through by name. Unselected optional: clear the
            // value so the action call omits the argument (the action's default applies).
            newProperties[param.name] = { ...property, value: selectedNames.has(param.name) ? param.name : "" };
        }
        // Derived return type: drive both the result type and the databinding target type.
        if (analysis.returnType) {
            for (const key of ["type", "targetType"]) {
                if (newProperties[key]) {
                    newProperties[key] = { ...newProperties[key], value: analysis.returnType };
                }
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
                streamElementType: analysis.streamElementType,
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
            {!loading && !saving && panelView === PanelView.UNSUPPORTED && (
                <UnsupportedContainer>
                    <WarningBox>
                        <Codicon name="warning" />
                        <div>
                            The selected action cannot be generated as an activity automatically.
                            <ReasonList>
                                {unsupportedReasons.map((reason, index) => (
                                    <li key={index}>{reason}</li>
                                ))}
                            </ReasonList>
                        </div>
                    </WarningBox>
                    <div>
                        To use this action in a workflow, create the activity manually:
                        <ReasonList>
                            <li>Create a new activity.</li>
                            <li>Configure the activity function signature (data types only).</li>
                            <li>Inside the activity, call the action with the parameters.</li>
                            <li>Return the result (anydata) as the activity output.</li>
                        </ReasonList>
                    </div>
                    <div>
                        <Button appearance="secondary" onClick={() => setPanelView(PanelView.CONNECTION_LIST)}>
                            Back
                        </Button>
                    </div>
                </UnsupportedContainer>
            )}
            {!saving && panelView === PanelView.ACTIVITY_FORM && (
                <ArtifactForm
                    preserveFieldOrder={true}
                    fileName={fileName}
                    targetLineRange={{ startLine: { line: 0, offset: 0 }, endLine: { line: 0, offset: 0 } }}
                    fields={fields}
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
