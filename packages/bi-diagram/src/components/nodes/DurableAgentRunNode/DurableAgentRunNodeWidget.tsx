/**
 * Copyright (c) 2025, WSO2 LLC. (https://www.wso2.com) All Rights Reserved.
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

/** @jsxImportSource @emotion/react */
import React, { ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import styled from "@emotion/styled";
import { css } from "@emotion/react";
import { DiagramEngine, PortWidget } from "@projectstorm/react-diagrams-core";
import { DurableAgentRunNodeModel } from "./DurableAgentRunNodeModel";
import {
    AGENT_NODE_ADD_TOOL_BUTTON_WIDTH,
    AGENT_NODE_TOOL_GAP,
    AGENT_NODE_TOOL_SECTION_GAP,
    CANVAS_BG_COLOR,
    DRAFT_NODE_BORDER_WIDTH,
    NODE_BG_BREAKPOINT_COLOR,
    NODE_BORDER_ERROR_COLOR,
    LABEL_HEIGHT,
    LABEL_WIDTH,
    LINK_COLOR,
    NODE_BG_COLOR,
    NODE_BG_HOVER_COLOR,
    NODE_HOVER_GLOW,
    NODE_BORDER_COLOR,
    NODE_BORDER_SELECTED_COLOR,
    NODE_BORDER_WIDTH,
    NODE_GAP_X,
    NODE_HEIGHT,
    NODE_PADDING,
    NODE_TEXT_COLOR,
    NODE_WIDTH,
} from "../../../resources/constants";
import { Button, Icon, Item, Menu, MenuItem, getAIModuleIcon, DefaultLlmIcon } from "@wso2/ui-toolkit";
import { MoreVertIcon } from "../../../resources/icons";
import { AgentData, FlowNode, ToolData } from "../../../utils/types";
import NodeIcon from "../../NodeIcon";
import ConnectorIcon from "../../ConnectorIcon";
import { useDiagramContext } from "../../DiagramContext";
import { DiagnosticsPopUp } from "../../DiagnosticsPopUp";
import { nodeHasError } from "../../../utils/node";
import { BreakpointMenu } from "../../BreakNodeMenu/BreakNodeMenu";
import { NodeMetadata } from "@wso2/ballerina-core";
import ReactMarkdown from "react-markdown";

export namespace NodeStyles {
    export const Node = styled.div<{ readOnly: boolean }>`
        display: flex;
        flex-direction: row;
        align-items: flex-start;
        cursor: ${(props: { readOnly: boolean }) => (props.readOnly ? "default" : "pointer")};
    `;

    export type NodeStyleProp = {
        disabled: boolean;
        hovered: boolean;
        hasError: boolean;
        readOnly: boolean;
        isActiveBreakpoint: boolean;
        isSelected?: boolean;
    };
    export const Box = styled.div<NodeStyleProp>`
        position: relative;
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: center;
        width: ${NODE_WIDTH}px;
        min-height: ${NODE_HEIGHT}px;
        padding: 0 ${NODE_PADDING}px;
        opacity: ${(props: NodeStyleProp) => (props.disabled ? 0.7 : 1)};
        border: ${(props: NodeStyleProp) => (props.disabled ? DRAFT_NODE_BORDER_WIDTH : NODE_BORDER_WIDTH)}px;
        border-style: ${(props: NodeStyleProp) => (props.disabled ? "dashed" : "solid")};
        border-color: ${(props: NodeStyleProp) =>
            props.hasError
                ? NODE_BORDER_ERROR_COLOR
                : props.isSelected && !props.disabled
                    ? NODE_BORDER_SELECTED_COLOR
                    : props.hovered && !props.disabled && !props.readOnly
                        ? NODE_BORDER_SELECTED_COLOR
                        : NODE_BORDER_COLOR};
        border-radius: 10px;
        background-color: ${(props: NodeStyleProp) =>
            props?.isActiveBreakpoint ? NODE_BG_BREAKPOINT_COLOR : props.hovered && !props.disabled && !props.readOnly ? NODE_BG_HOVER_COLOR : NODE_BG_COLOR};
        color: ${NODE_TEXT_COLOR};
        box-shadow: ${(props: NodeStyleProp) => props.hovered && !props.disabled && !props.readOnly ? NODE_HOVER_GLOW : 'none'};
        transition: box-shadow 0.1s ease, background-color 0.1s ease, border-color 0.1s ease;
    `;

    export const Header = styled.div<{}>`
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: flex-start;
        gap: 2px;
        width: 100%;
        padding: 8px;
        margin-top: 2px;
    `;

    export const TopPortWidget = styled(PortWidget)`
        margin-top: -3px;
        z-index: 2;
    `;

    export const BottomPortWidget = styled(PortWidget)`
        margin-bottom: -2px;
        z-index: 2;
    `;

    export const StyledText = styled.div`
        font-size: 14px;
    `;

    export const Icon = styled.div`
        padding: 4px;
        svg {
            fill: ${NODE_TEXT_COLOR};
        }
    `;

    export const Title = styled(StyledText)`
        height: 18px !important;
        max-width: ${NODE_WIDTH - 80}px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-family: "GilmerMedium";
    `;

    export const Description = styled(StyledText)`
        font-size: 12px;
        max-width: ${NODE_WIDTH - 80}px;
        overflow: hidden;
        text-overflow: ellipsis;
        font-family: monospace;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        color: ${NODE_TEXT_COLOR};
        opacity: 0.7;
        margin-top: -2px;
    `;

    const MarkdownContent = styled.div`
        font-size: 12px;
        line-height: 1.4;
        width: 100%;

        p {
            margin: 0 0 0.3em 0;
            padding: 0;
        }

        p:last-child {
            margin-bottom: 0;
        }

        h1, h2, h3, h4, h5, h6 {
            margin: 0.4em 0 0.2em 0;
            padding: 0;
            font-weight: 600;
            font-size: 12px;
        }

        ul, ol {
            margin: 0.3em 0;
            padding-left: 1.2em;
        }

        li {
            margin: 0 0 0.1em 0;
        }

        code {
            background-color: rgba(127, 127, 127, 0.1);
            padding: 1px 3px;
            border-radius: 2px;
            font-size: 11px;
        }

        blockquote {
            margin: 0.3em 0;
            padding-left: 8px;
            border-left: 2px solid ${NODE_BORDER_COLOR};
        }

        strong {
            font-weight: 600;
        }

        em {
            font-style: italic;
        }

        a {
            color: ${LINK_COLOR};
            text-decoration: none;
        }
    `;

    export const Role = styled(MarkdownContent)`
        color: ${LINK_COLOR};
        font-family: "GilmerMedium";
        font-weight: bold;
        padding: 0 4px;
        overflow: hidden;
        display: -webkit-box;
        -webkit-line-clamp: 1;
        -webkit-box-orient: vertical;

        /* Override paragraph margins for single line display */
        p {
            display: inline;
            margin: 0;
        }
    `;

    export const RolePlaceholder = styled(Role)`
        color: ${NODE_TEXT_COLOR};
        opacity: 0.5;
        font-style: italic;
    `;

    export const Instructions = styled(MarkdownContent)`
        color: ${NODE_TEXT_COLOR};
        opacity: 0.7;
        overflow: hidden;
        height: 100%;
        max-height: calc(100% - 5px);
        padding: 0 4px 4px;
    `;

    export const InstructionsPlaceholder = styled(Instructions)`
        opacity: 0.5;
        font-style: italic;
    `;

    export const InstructionsRow = styled.div<{ readOnly: boolean }>`
        flex: 1;
        overflow: hidden;
        align-items: flex-start;
        margin-bottom: 6px;
        cursor: ${(props: { readOnly: boolean }) => (props.readOnly ? "default" : "pointer")};
        z-index: 2;
    `;

    export const Row = styled.div<{ readOnly: boolean }>`
        display: flex;
        flex-direction: row;
        justify-content: space-between;
        align-items: center;
        width: 100%;
        cursor: ${(props: { readOnly: boolean }) => (props.readOnly ? "default" : "pointer")};
        z-index: 2;
    `;

    export const Column = styled.div`
        display: flex;
        flex-direction: column;
        justify-content: flex-start;
        align-items: flex-start;
        gap: 8px;
        width: 100%;
        height: 100%;
        overflow: hidden;
    `;

    export const ActionButtonGroup = styled.div`
        display: flex;
        flex-direction: row;
        justify-content: flex-end;
        align-items: center;
        gap: 2px;
    `;

    export const MenuButton = styled(Button)`
        border-radius: 5px;
    `;

    export const AddItemContainer = styled.div`
        display: flex;
        flex-direction: row;
        gap: 8px;
        width: 100%;
        border-bottom: 1px dashed ${NODE_BORDER_COLOR};
        padding-bottom: 8px;
        z-index: 2;
    `;

    export const AddItemButton = styled.div<{ readOnly: boolean }>`
        display: flex;
        align-items: center;
        justify-content: center;
        flex: 1;
        margin: 8px 0;
        padding: 8px 0;
        border: 1px solid ${NODE_BORDER_COLOR};
        border-radius: 4px;
        background-color: transparent;
        color: ${NODE_TEXT_COLOR};
        font-size: 13px;
        font-family: "GilmerRegular";
        white-space: nowrap;
        cursor: ${(props: { readOnly: boolean }) => (props.readOnly ? "default" : "pointer")};
        &:hover {
            background-color: ${CANVAS_BG_COLOR};
            border-color: ${(props: { readOnly: boolean }) =>
            props.readOnly ? NODE_BORDER_COLOR : NODE_BORDER_SELECTED_COLOR};
        }
    `;
}

interface DurableAgentRunNodeWidgetProps {
    model: DurableAgentRunNodeModel;
    engine: DiagramEngine;
    onClick?: (node: FlowNode) => void;
}

export interface NodeWidgetProps extends Omit<DurableAgentRunNodeWidgetProps, "children"> { }

type DurableAgentNodeMetadata = NodeMetadata & {
    activities?: ToolData[];
    humanTasks?: ToolData[];
};

type CapabilityItem = {
    data: ToolData;
    kind: "tool" | "activity" | "humanTask";
};

export function DurableAgentRunNodeWidget(props: DurableAgentRunNodeWidgetProps) {
    const { model, engine, onClick } = props;
    const { onNodeSelect, goToSource, onDeleteNode, removeBreakpoint, addBreakpoint, agentNode, readOnly, selectedNodeId } =
        useDiagramContext();

    const isSelected = selectedNodeId === model.node.id;

    const [isBoxHovered, setIsBoxHovered] = useState(false);
    const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
    const [menuButtonElement, setMenuButtonElement] = useState<HTMLElement | null>(null);
    const isMenuOpen = menuPos !== null;

    const getMenuPos = (el: HTMLElement): { top: number; left: number } => {
        const rect = el.getBoundingClientRect();
        return { top: rect.bottom, left: rect.left };
    };

    useEffect(() => {
        if (!isMenuOpen || !menuButtonElement) return;
        const handle = engine.getModel().registerListener({
            offsetUpdated: () => setMenuPos(getMenuPos(menuButtonElement)),
            zoomUpdated: () => setMenuPos(getMenuPos(menuButtonElement)),
        });
        return () => handle.deregister();
    }, [isMenuOpen, menuButtonElement]);

    useEffect(() => {
        if (!isMenuOpen) return;
        const handleClickOutside = () => setMenuPos(null);
        const timer = setTimeout(() => document.addEventListener("mousedown", handleClickOutside), 0);
        return () => {
            clearTimeout(timer);
            document.removeEventListener("mousedown", handleClickOutside);
        };
    }, [isMenuOpen]);

    const hasBreakpoint = model.hasBreakpoint();
    const isActiveBreakpoint = model.isActiveBreakpoint();

    useEffect(() => {
        if (model.node.suggested) {
            model.setAroundLinksDisabled(model.node.suggested === true);
        }
    }, [model.node.suggested]);

    const handleOnClick = (event: React.MouseEvent<HTMLDivElement>) => {
        if (readOnly) {
            return;
        }
        if (event.metaKey) {
            onGoToSource();
        } else {
            onNodeClick();
        }
    };

    const onNodeClick = () => {
        onClick && onClick(model.node);
        onNodeSelect && onNodeSelect(model.node);
        setMenuPos(null);
    };

    const onGoToSource = () => {
        goToSource && goToSource(model.node);
        setMenuPos(null);
    };

    const deleteNode = () => {
        onDeleteNode && onDeleteNode(model.node);
        setMenuPos(null);
    };

    const onAddBreakpoint = () => {
        addBreakpoint && addBreakpoint(model.node);
        setMenuPos(null);
    };

    const onRemoveBreakpoint = () => {
        removeBreakpoint && removeBreakpoint(model.node);
        setMenuPos(null);
    };

    const onModelEditClick = () => {
        if (readOnly) {
            return;
        }
        agentNode?.onModelSelect?.(model.node);
        setMenuPos(null);
    };

    const onAddToolClick = () => {
        if (readOnly) {
            return;
        }
        agentNode?.onAddTool?.(model.node);
        setMenuPos(null);
    };

    const onAddActivityClick = () => {
        if (readOnly) {
            return;
        }
        agentNode?.onAddActivity?.(model.node);
        setMenuPos(null);
    };

    const onAddHumanTaskClick = () => {
        if (readOnly) {
            return;
        }
        agentNode?.onAddHumanTask?.(model.node);
        setMenuPos(null);
    };

    const handleOnMenuClick = (event: React.MouseEvent<HTMLElement | SVGSVGElement>) => {
        if (readOnly) {
            return;
        }
        event.stopPropagation();
        const target = menuButtonElement || (event.currentTarget as HTMLElement);
        setMenuPos(getMenuPos(target));
    };

    const handleOnContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
        event.preventDefault();
        const target = menuButtonElement || event.currentTarget;
        setMenuPos(getMenuPos(target as HTMLElement));
    };

    const menuItems: Item[] = [
        {
            id: "edit",
            label: "Edit",
            onClick: () => onNodeClick(),
        },
        { id: "goToSource", label: "Source", onClick: () => onGoToSource() },
        { id: "delete", label: "Delete", onClick: () => deleteNode() },
    ];

    const disabled = model.node.suggested;
    const nodeTitle = model.node.metadata.label || "Durable Agent";
    const hasError = nodeHasError(model.node);
    const nodeMetadata = model?.node?.metadata?.data as DurableAgentNodeMetadata;
    const nodeModelIconUrl = nodeMetadata?.model?.path;

    const sanitizedAgent = nodeMetadata?.agent ? sanitizeAgentData(nodeMetadata.agent) : undefined;

    // Capability circles rendered on the right side: AI tools, activities and human tasks.
    const capabilityItems: CapabilityItem[] = [
        ...(nodeMetadata?.tools || []).map((tool: ToolData): CapabilityItem => ({ data: tool, kind: "tool" })),
        ...(nodeMetadata?.activities || []).map((activity: ToolData): CapabilityItem => ({ data: activity, kind: "activity" })),
        ...(nodeMetadata?.humanTasks || []).map((humanTask: ToolData): CapabilityItem => ({ data: humanTask, kind: "humanTask" })),
    ];

    let containerHeight =
        NODE_HEIGHT + AGENT_NODE_TOOL_SECTION_GAP + AGENT_NODE_ADD_TOOL_BUTTON_WIDTH + AGENT_NODE_TOOL_GAP * 2;
    if (capabilityItems.length > 0) {
        containerHeight += capabilityItems.length * (NODE_HEIGHT + AGENT_NODE_TOOL_GAP);
    }

    const renderCapabilityIcon = (item: CapabilityItem) => {
        if (item.kind === "activity") {
            return <Icon name="bi-task" sx={{ fontSize: "24px" }} />;
        }
        if (item.kind === "humanTask") {
            return <Icon name="bi-user" sx={{ fontSize: "24px" }} />;
        }
        if (item.data.path) {
            return (
                <ConnectorIcon
                    url={item.data.path}
                    style={{ width: 24, height: 24, fontSize: 24 }}
                    fallbackIcon={<Icon name="bi-function" sx={{ fontSize: "24px" }} />}
                    codedata={model.node?.codedata}
                />
            );
        }
        return <Icon name="bi-function" sx={{ fontSize: "24px" }} />;
    };

    return (
        <NodeStyles.Node data-testid="durable-agent-run-node" readOnly={readOnly}>
            <NodeStyles.Box
                disabled={disabled}
                hovered={isBoxHovered}
                hasError={hasError}
                readOnly={readOnly}
                isActiveBreakpoint={isActiveBreakpoint}
                isSelected={isSelected}
                onMouseEnter={() => setIsBoxHovered(true)}
                onMouseLeave={() => setIsBoxHovered(false)}
                onContextMenu={!readOnly ? handleOnContextMenu : undefined}
                title="Configure Agent"
            >
                {hasBreakpoint && (
                    <div
                        data-testid={isActiveBreakpoint ? "breakpoint-indicator-diagram-active" : "breakpoint-indicator-diagram"}
                        style={{
                            position: "absolute",
                            left: -5,
                            width: 15,
                            height: 15,
                            borderRadius: "50%",
                            backgroundColor: "red",
                            zIndex: 2,
                        }}
                    />
                )}
                <NodeStyles.TopPortWidget port={model.getPort("in")!} engine={engine} />
                <NodeStyles.Column style={{ height: `${model.node.viewState?.ch}px` }}>
                    <NodeStyles.Row readOnly={readOnly}>
                        <NodeStyles.Icon onClick={handleOnClick}>
                            <NodeIcon type={model.node.codedata.node} size={24} />
                        </NodeStyles.Icon>
                        <NodeStyles.Row readOnly={readOnly}>
                            <NodeStyles.Header onClick={handleOnClick}>
                                <NodeStyles.Title>{nodeTitle}</NodeStyles.Title>
                                <NodeStyles.Description>
                                    {model.node.properties?.variable?.value as ReactNode}
                                </NodeStyles.Description>
                            </NodeStyles.Header>
                            <NodeStyles.ActionButtonGroup>
                                {hasError && <DiagnosticsPopUp node={model.node} engine={engine} />}
                                <NodeStyles.MenuButton
                                    ref={setMenuButtonElement}
                                    buttonSx={readOnly ? { cursor: "not-allowed" } : {}}
                                    appearance="icon"
                                    onClick={handleOnMenuClick}
                                >
                                    <MoreVertIcon />
                                </NodeStyles.MenuButton>
                            </NodeStyles.ActionButtonGroup>
                        </NodeStyles.Row>
                        {isMenuOpen && menuPos && createPortal(
                            <div
                                style={{
                                    position: "fixed",
                                    top: menuPos.top,
                                    left: menuPos.left,
                                    zIndex: 1300,
                                    boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
                                    borderRadius: 0,
                                }}
                                onMouseDown={(e) => e.stopPropagation()}
                            >
                                <Menu>
                                    <>
                                        {menuItems.map((item) => (
                                            <MenuItem key={item.id} item={item} />
                                        ))}
                                        <BreakpointMenu
                                            hasBreakpoint={hasBreakpoint}
                                            onAddBreakpoint={onAddBreakpoint}
                                            onRemoveBreakpoint={onRemoveBreakpoint}
                                        />
                                    </>
                                </Menu>
                            </div>,
                            document.body
                        )}
                    </NodeStyles.Row>

                    <NodeStyles.AddItemContainer>
                        <NodeStyles.AddItemButton readOnly={readOnly} onClick={onAddActivityClick} title="Add Activity">
                            <Icon name="bi-plus" sx={{ fontSize: "16px", marginRight: "4px" }} />
                            Add Activity
                        </NodeStyles.AddItemButton>
                        <NodeStyles.AddItemButton readOnly={readOnly} onClick={onAddHumanTaskClick} title="Add Human Task">
                            <Icon name="bi-plus" sx={{ fontSize: "16px", marginRight: "4px" }} />
                            Add Human Task
                        </NodeStyles.AddItemButton>
                    </NodeStyles.AddItemContainer>

                    {
                        sanitizedAgent?.role ? (
                            <NodeStyles.Row readOnly={readOnly} onClick={handleOnClick}>
                                <NodeStyles.Role>
                                    <ReactMarkdown
                                        disallowedElements={['script', 'iframe', 'object', 'embed', 'link', 'style']}
                                        unwrapDisallowed={true}
                                    >
                                        {sanitizedAgent?.role}
                                    </ReactMarkdown>
                                </NodeStyles.Role>
                            </NodeStyles.Row>
                        ) : (
                            <NodeStyles.Row readOnly={readOnly} onClick={handleOnClick}>
                                <NodeStyles.RolePlaceholder>Define agent's role</NodeStyles.RolePlaceholder>
                            </NodeStyles.Row>
                        )
                    }

                    {
                        sanitizedAgent?.instructions ? (
                            <NodeStyles.InstructionsRow readOnly={readOnly} onClick={handleOnClick}>
                                <NodeStyles.Instructions>
                                    <ReactMarkdown
                                        disallowedElements={['script', 'iframe', 'object', 'embed', 'link', 'style']}
                                        unwrapDisallowed={true}
                                    >
                                        {sanitizedAgent?.instructions}
                                    </ReactMarkdown>
                                </NodeStyles.Instructions>
                            </NodeStyles.InstructionsRow>
                        ) : (
                            <NodeStyles.InstructionsRow readOnly={readOnly} onClick={handleOnClick}>
                                <NodeStyles.InstructionsPlaceholder>
                                    Provide specific instructions on how the agent should behave.
                                </NodeStyles.InstructionsPlaceholder>
                            </NodeStyles.InstructionsRow>
                        )
                    }
                </NodeStyles.Column>
                <NodeStyles.BottomPortWidget port={model.getPort("out")!} engine={engine} />
            </NodeStyles.Box>

            <svg
                width={NODE_GAP_X + NODE_HEIGHT + LABEL_HEIGHT + LABEL_WIDTH + 10}
                height={model.node.viewState?.ch}
                viewBox={`0 0 300 ${containerHeight}`}
                style={{ marginLeft: "-10px", position: "relative", zIndex: 1 }}
            >
                {/* durable agent model circle */}
                <g>
                    <circle
                        cx="80"
                        cy="24"
                        r="22"
                        fill={NODE_BG_COLOR}
                        stroke={NODE_BORDER_COLOR}
                        strokeWidth={1.5}
                        strokeDasharray={disabled ? "5 5" : "none"}
                        opacity={disabled ? 0.7 : 1}
                        onClick={onModelEditClick}
                        css={css`
                            cursor: ${readOnly ? "default" : "pointer"};
                            transition: stroke 0.4s ease-out;
                            &:hover {
                                stroke: ${readOnly ? NODE_BORDER_COLOR : NODE_BORDER_SELECTED_COLOR};
                            }
                        `}
                    >
                        <title>{"Configure Model Provider"}</title>
                    </circle>

                    <foreignObject
                        x="68"
                        y="12"
                        width="44"
                        height="44"
                        fill={NODE_TEXT_COLOR}
                        style={{ pointerEvents: "none" }}
                    >
                        {getAIModuleIcon(nodeMetadata?.model?.type) ?? (nodeModelIconUrl ? <img src={nodeModelIconUrl} style={{ width: 24, height: 24 }} /> : <Icon name="bi-ai-model" sx={{ fontSize: 24, width: 24, height: 24 }} />)}
                    </foreignObject>

                    <line
                        x1="0"
                        y1="25"
                        x2="57"
                        y2="25"
                        style={{
                            stroke: NODE_TEXT_COLOR,
                            strokeWidth: 1.5,
                            markerEnd: `url(#${model.node.id}-arrow-head)`,
                            markerStart: `url(#${model.node.id}-diamond-start)`,
                        }}
                    />
                </g>

                {/* circles for tools, activities and human tasks */}
                {capabilityItems.map((item: CapabilityItem, index: number) => {
                    const itemName = item.data.name;
                    return (
                        <g
                            key={`${item.kind}-${itemName}-${index}`}
                            transform={`translate(0, ${(index + 1) * (NODE_HEIGHT + AGENT_NODE_TOOL_GAP) + AGENT_NODE_TOOL_SECTION_GAP
                                })`}
                        >
                            <circle
                                cx="80"
                                cy="24"
                                r="22"
                                fill={NODE_BG_COLOR}
                                stroke={NODE_BORDER_COLOR}
                                strokeWidth={1.5}
                                strokeDasharray={disabled ? "5 5" : "none"}
                                opacity={disabled ? 0.7 : 1}
                            >
                                <title>{itemName}</title>
                            </circle>

                            <foreignObject
                                x="68"
                                y="12"
                                width="44"
                                height="44"
                                fill={NODE_TEXT_COLOR}
                                style={{ pointerEvents: "none" }}
                            >
                                <div className="connector-icon">{renderCapabilityIcon(item)}</div>
                            </foreignObject>

                            <text
                                x="110"
                                y="28"
                                textAnchor="start"
                                fill={NODE_TEXT_COLOR}
                                fontSize="14px"
                                fontFamily="GilmerRegular"
                                dominantBaseline="middle"
                            >
                                {itemName.length > 20 ? `${itemName.slice(0, 20)}...` : itemName}
                                <title>{itemName}</title>
                            </text>

                            <line
                                x1="0"
                                y1="25"
                                x2="57"
                                y2="25"
                                style={{
                                    stroke: NODE_TEXT_COLOR,
                                    strokeWidth: 1.5,
                                    markerEnd: `url(#${model.node.id}-arrow-head-item-${item.kind}-${sanitizeId(itemName)})`,
                                    strokeDasharray: "6 6",
                                }}
                            />
                        </g>
                    );
                })}

                {/* Add "Add new tool" button below all capability circles — hidden in read-only mode */}
                {!readOnly && <g
                    transform={`translate(-11, ${capabilityItems.length > 0
                        ? (capabilityItems.length + 1) * (NODE_HEIGHT + AGENT_NODE_TOOL_GAP) + AGENT_NODE_TOOL_SECTION_GAP
                        : NODE_HEIGHT + AGENT_NODE_TOOL_SECTION_GAP
                        })`}
                    onClick={onAddToolClick}
                    style={{ cursor: "pointer" }}
                >
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="20"
                        height="20"
                        viewBox="0 0 24 24"
                        css={css`
                            cursor: ${readOnly ? "not-allowed" : "pointer"};
                            &:hover path:last-of-type {
                                fill: ${NODE_BORDER_SELECTED_COLOR};
                            }
                            &:hover + .custom-tooltip {
                                opacity: 1;
                                visibility: visible;
                            }
                        `}
                    >
                        <title>Add New Tool / MCP Server</title>
                        <path
                            fill={CANVAS_BG_COLOR}
                            d="M12 0C5 0 0 5 0 12s5 12 12 12 12-5 12-12S19 0 12 0z"
                        />
                        <path
                            fill={NODE_TEXT_COLOR}
                            d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2m0 18a8 8 0 1 1 8-8a8 8 0 0 1-8 8m4-9h-3V8a1 1 0 0 0-2 0v3H8a1 1 0 0 0 0 2h3v3a1 1 0 0 0 2 0v-3h3a1 1 0 0 0 0-2"
                        />
                    </svg>

                    {/* Custom tooltip */}
                    <foreignObject x="25" y="-10" width="100" height="30" style={{ pointerEvents: "none" }}>
                        <div
                            className="custom-tooltip"
                            css={css`
                                background-color: ${CANVAS_BG_COLOR};
                                color: ${NODE_TEXT_COLOR};
                                padding: 4px 8px;
                                border-radius: 4px;
                                font-size: 12px;
                                box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
                                opacity: 0;
                                visibility: hidden;
                                transition: opacity 0.2s ease-in-out;
                                pointer-events: none;
                                white-space: nowrap;
                                font-family: "GilmerRegular";
                            `}
                        >
                            Add New Tool / MCP Server
                        </div>
                    </foreignObject>
                </g>}

                <defs>
                    <marker
                        id={`${model.node.id}-arrow-head`}
                        markerWidth="4"
                        markerHeight="4"
                        refX="3"
                        refY="2"
                        viewBox="0 0 4 4"
                        orient="auto"
                    >
                        <polygon points="0,4 0,0 4,2" fill={NODE_TEXT_COLOR}></polygon>
                    </marker>

                    <marker
                        id={`${model.node.id}-diamond-start`}
                        markerWidth="8"
                        markerHeight="8"
                        refX="4.5"
                        refY="4"
                        viewBox="0 0 8 8"
                        orient="auto"
                    >
                        <circle
                            cx="4"
                            cy="4"
                            r="3"
                            fill={NODE_BG_COLOR}
                            stroke={NODE_TEXT_COLOR}
                            strokeWidth="1"
                        />
                    </marker>
                    {capabilityItems.map((item: CapabilityItem, index: number) => (
                        <marker
                            key={`${item.kind}-${item.data.name}-${index}`}
                            id={`${model.node.id}-arrow-head-item-${item.kind}-${sanitizeId(item.data.name)}`}
                            markerWidth="4"
                            markerHeight="4"
                            refX="3"
                            refY="2"
                            viewBox="0 0 4 4"
                            orient="auto"
                        >
                            <polygon points="0,4 0,0 4,2" fill={NODE_TEXT_COLOR}></polygon>
                        </marker>
                    ))}
                </defs>
            </svg>
        </NodeStyles.Node>
    );
}

// sanitize a string for use as an SVG/HTML id attribute
function sanitizeId(name: string): string {
    return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

// sanitize agent instructions and role
// remove leading and trailing quotes
// remove suffix "string `" and prefix "`"
function stripWrappingQuotes(str: string): string {
    // Handle `string \`...\`` template format — backticks are the definitive wrapper, no further stripping needed
    if (str.startsWith('string `') && str.endsWith('`')) {
        return str.slice('string `'.length, -1);
    }
    // Only strip quotes if wrapped in a single matching pair (not multiple like """...""")
    if (
        ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'")))
        && !(str.startsWith('""') || str.startsWith("''"))
    ) {
        return str.slice(1, -1);
    }
    return str;
}

function sanitizeAgentData(data: AgentData): AgentData {
    return {
        ...data,
        role: data.role ? stripWrappingQuotes(data.role) : data.role,
        instructions: data.instructions ? stripWrappingQuotes(data.instructions) : data.instructions,
    };
}
