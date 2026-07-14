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

import io.ballerina.compiler.api.SemanticModel;
import io.ballerina.compiler.api.symbols.FunctionTypeSymbol;
import io.ballerina.compiler.api.symbols.MethodSymbol;
import io.ballerina.compiler.api.symbols.ParameterKind;
import io.ballerina.compiler.api.symbols.ParameterSymbol;
import io.ballerina.compiler.api.symbols.RecordFieldSymbol;
import io.ballerina.compiler.api.symbols.RecordTypeSymbol;
import io.ballerina.compiler.api.symbols.ResourceMethodSymbol;
import io.ballerina.compiler.api.symbols.StreamTypeSymbol;
import io.ballerina.compiler.api.symbols.TypeDescKind;
import io.ballerina.compiler.api.symbols.TypeSymbol;
import io.ballerina.compiler.api.symbols.UnionTypeSymbol;
import io.ballerina.flowmodelgenerator.core.utils.ParamUtils;
import io.ballerina.modelgenerator.commons.CommonUtils;
import io.ballerina.modelgenerator.commons.ParameterData;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Analyzes a connector action's signature to decide whether a {@code @workflow:Activity} can be
 * generated from it automatically, and derives the activity's parameters and return type.
 *
 * <p>Rules (all types must be data types so the activity is serializable):
 * <ul>
 *   <li>Required parameters are always included; defaultable parameters are optional (selectable).</li>
 *   <li>Included-record parameters are expanded into their record fields (required/optional).</li>
 *   <li>Rest parameters are not supported.</li>
 *   <li>A parameter/return type must be {@code anydata} or a union that <em>contains</em>
 *       {@code anydata} — non-anydata union members are dropped. A {@code stream<T,…>} return is
 *       collected into {@code T[]}. Anything else makes the action unsupported.</li>
 * </ul>
 *
 * @since 1.5.0
 */
public final class ActionSignatureAnalyzer {

    private ActionSignatureAnalyzer() {
    }

    /**
     * A derived activity parameter.
     *
     * @param name     the parameter name (matches the action parameter / record field)
     * @param type     the derived (anydata) type signature
     * @param required whether the parameter is required (always included, not toggleable)
     */
    public record DerivedParam(String name, String type, boolean required) {
    }

    /**
     * The result of analyzing an action signature.
     *
     * @param supported         whether an activity can be generated automatically
     * @param reasons           when unsupported, the human-readable reasons
     * @param params            the derived activity parameters (empty when unsupported)
     * @param returnType        the derived activity return type (success type, without {@code |error})
     * @param streamElementType when the action returns a stream, its element type (the activity
     *                          returns {@code streamElementType[]} collected from the stream); else null
     */
    public record Analysis(boolean supported, List<String> reasons, List<DerivedParam> params,
                           String returnType, String streamElementType) {
    }

    /**
     * Analyzes a connector action method. For resource methods, the resource path parameters are
     * included as required activity parameters (they are referenced inside the resource path of the
     * generated action call).
     */
    public static Analysis analyze(MethodSymbol methodSymbol, SemanticModel semanticModel) {
        List<DerivedParam> pathParams = new ArrayList<>();
        List<String> pathReasons = new ArrayList<>();
        if (methodSymbol instanceof ResourceMethodSymbol) {
            TypeSymbol anydata = semanticModel.types().ANYDATA;
            ParamUtils.ResourcePathTemplate resourcePathTemplate = ParamUtils.buildResourcePathTemplate(
                    semanticModel, methodSymbol, semanticModel.types().ERROR);
            for (ParameterData pathParam : resourcePathTemplate.pathParams()) {
                if (pathParam.kind() == ParameterData.Kind.PATH_REST_PARAM) {
                    pathReasons.add("Rest resource path parameter is not supported");
                    continue;
                }
                if (pathParam.typeSymbol() == null || !CommonUtils.subTypeOf(pathParam.typeSymbol(), anydata)) {
                    pathReasons.add("Path parameter '" + pathParam.name() + "' is not a data type");
                    continue;
                }
                pathParams.add(new DerivedParam(pathParam.name(), pathParam.type(), true));
            }
        }
        Analysis analysis = analyze(methodSymbol.typeDescriptor(), semanticModel);
        List<String> reasons = new ArrayList<>(pathReasons);
        reasons.addAll(analysis.reasons());
        List<DerivedParam> params = new ArrayList<>(pathParams);
        params.addAll(analysis.params());
        return new Analysis(reasons.isEmpty(), reasons, params, analysis.returnType(),
                analysis.streamElementType());
    }

    public static Analysis analyze(FunctionTypeSymbol functionTypeSymbol, SemanticModel semanticModel) {
        TypeSymbol anydata = semanticModel.types().ANYDATA;
        List<String> reasons = new ArrayList<>();
        List<DerivedParam> params = new ArrayList<>();

        for (ParameterSymbol param : functionTypeSymbol.params().orElse(List.of())) {
            // Skip the typedesc parameter used for return-type inference; the return type is derived
            // separately below.
            if (CommonUtils.getRawType(param.typeDescriptor()).typeKind() == TypeDescKind.TYPEDESC) {
                continue;
            }
            String name = param.getName().orElse("");
            ParameterKind kind = param.paramKind();
            if (kind == ParameterKind.REST) {
                reasons.add("Rest parameter '" + name + "' is not supported");
            } else if (kind == ParameterKind.INCLUDED_RECORD) {
                expandIncludedRecord(param.typeDescriptor(), params, reasons, anydata);
            } else {
                // REQUIRED or DEFAULTABLE
                boolean required = kind == ParameterKind.REQUIRED;
                addParam(params, reasons, name, param.typeDescriptor(), required, anydata);
            }
        }

        String returnType = "";
        String streamElementType = null;
        Optional<TypeSymbol> optReturnType = functionTypeSymbol.returnTypeDescriptor();
        if (optReturnType.isPresent()) {
            ReturnDerivation derived = deriveReturnType(optReturnType.get(), anydata);
            if (derived == null) {
                reasons.add("Return type '" + optReturnType.get().signature()
                        + "' is not a data type (it must be, or contain, anydata)");
            } else {
                returnType = derived.type;
                streamElementType = derived.streamElementType;
            }
        }

        boolean supported = reasons.isEmpty();
        return new Analysis(supported, reasons, params, returnType, streamElementType);
    }

    private static void addParam(List<DerivedParam> params, List<String> reasons, String name,
                                 TypeSymbol type, boolean required, TypeSymbol anydata) {
        String derived = deriveDataType(type, anydata);
        if (derived == null) {
            reasons.add("Parameter '" + name + "' of type '" + type.signature()
                    + "' is not a data type (it must be, or contain, anydata)");
            return;
        }
        params.add(new DerivedParam(name, derived, required));
    }

    private static void expandIncludedRecord(TypeSymbol type, List<DerivedParam> params, List<String> reasons,
                                             TypeSymbol anydata) {
        TypeSymbol rawType = CommonUtils.getRawType(type);
        if (rawType.typeKind() != TypeDescKind.RECORD) {
            reasons.add("Included record parameter of type '" + type.signature() + "' is not supported");
            return;
        }
        Map<String, RecordFieldSymbol> fields = ((RecordTypeSymbol) rawType).fieldDescriptors();
        for (Map.Entry<String, RecordFieldSymbol> entry : fields.entrySet()) {
            RecordFieldSymbol field = entry.getValue();
            boolean required = !field.isOptional() && !field.hasDefaultValue();
            addParam(params, reasons, entry.getKey(), field.typeDescriptor(), required, anydata);
        }
    }

    /**
     * Derives the data (anydata) type for a parameter: the type itself if it is anydata, or the union
     * of its anydata members (dropping non-anydata members). Returns {@code null} if the type has no
     * anydata part.
     */
    private static String deriveDataType(TypeSymbol type, TypeSymbol anydata) {
        if (CommonUtils.subTypeOf(type, anydata)) {
            return type.signature();
        }
        TypeSymbol rawType = CommonUtils.getRawType(type);
        if (rawType.typeKind() != TypeDescKind.UNION) {
            return null;
        }
        List<String> anydataMembers = new ArrayList<>();
        for (TypeSymbol member : ((UnionTypeSymbol) rawType).memberTypeDescriptors()) {
            TypeSymbol rawMember = CommonUtils.getRawType(member);
            if (rawMember.typeKind() == TypeDescKind.ERROR || rawMember.typeKind() == TypeDescKind.NIL) {
                continue;
            }
            if (CommonUtils.subTypeOf(member, anydata)) {
                anydataMembers.add(member.signature());
            }
        }
        return anydataMembers.isEmpty() ? null : String.join("|", anydataMembers);
    }

    private record ReturnDerivation(String type, String streamElementType) {
    }

    /**
     * Derives the activity return type from the action return type: strips {@code error}, collects a
     * {@code stream<T,…>} into {@code T[]}, or takes the first anydata member of a union. Returns
     * {@code null} if there is no usable data return type.
     */
    private static ReturnDerivation deriveReturnType(TypeSymbol returnType, TypeSymbol anydata) {
        TypeSymbol rawType = CommonUtils.getRawType(returnType);

        // Collect the non-error/non-nil members.
        List<TypeSymbol> members = new ArrayList<>();
        if (rawType.typeKind() == TypeDescKind.UNION) {
            for (TypeSymbol member : ((UnionTypeSymbol) rawType).memberTypeDescriptors()) {
                TypeDescKind kind = CommonUtils.getRawType(member).typeKind();
                if (kind != TypeDescKind.ERROR && kind != TypeDescKind.NIL) {
                    members.add(member);
                }
            }
        } else if (rawType.typeKind() != TypeDescKind.ERROR && rawType.typeKind() != TypeDescKind.NIL) {
            members.add(returnType);
        }
        if (members.isEmpty()) {
            // Only error?/nil: the activity has no data return value.
            return new ReturnDerivation("", null);
        }

        // A stream member is collected into an array of its element type.
        for (TypeSymbol member : members) {
            TypeSymbol rawMember = CommonUtils.getRawType(member);
            if (rawMember.typeKind() == TypeDescKind.STREAM) {
                TypeSymbol elementType = ((StreamTypeSymbol) rawMember).typeParameter();
                if (CommonUtils.subTypeOf(elementType, anydata)) {
                    return new ReturnDerivation(elementType.signature() + "[]", elementType.signature());
                }
            }
        }

        // Otherwise take the first anydata member.
        for (TypeSymbol member : members) {
            if (CommonUtils.subTypeOf(member, anydata)) {
                return new ReturnDerivation(member.signature(), null);
            }
        }
        return null;
    }
}
