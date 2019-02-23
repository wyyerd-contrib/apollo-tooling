import "apollo-env";
import {
  GraphQLSchema,
  extendSchema,
  Kind,
  TypeDefinitionNode,
  TypeExtensionNode,
  isTypeDefinitionNode,
  isTypeExtensionNode,
  GraphQLError,
  GraphQLNamedType,
  isObjectType,
  FieldDefinitionNode
} from "graphql";
import { validateSDL } from "graphql/validation/validate";
import federationDirectives from "./directives";
import {
  findDirectivesOnTypeOrField,
  isStringValueNode,
  parseSelections,
  isNotNullOrUndefined
} from "./utils";
import { ServiceDefinition, ServiceName } from "./types";

export function composeServices(services: ServiceDefinition[]) {
  let errors: GraphQLError[] | undefined = undefined;
  // Map of all definitions to eventually be passed to extendSchema
  const definitionsMap: {
    [name: string]: TypeDefinitionNode[];
  } = Object.create(null);

  // Map of all extensions to eventually be passed to extendSchema
  const extensionsMap: {
    [name: string]: TypeExtensionNode[];
  } = Object.create(null);

  /**
   * A map of base types to their owning service. Used by query planner to direct traffic.
   * This contains the base type's "owner". Any fields that extend this type in another service
   * are listed under "extensionFields". extensionFields are in the format { myField: my-service-name }
   *
   * Example services with resulting serviceMap shape
   *
   * ProductService:
   * type Product {
   *   sku: String!
   *   color: String
   * }
   *
   * ReviewService:
   * extend type Product {
   *   reviews: [Review!]!
   * }
   *
   * ShippingService:
   * extend type Product {
   *   dimensions: [Dimensions!]
   *   weight: Int
   * }
   *
   * const serviceMap = {
   *   Product: {
   *     serviceName: "ProductService",
   *     extensionFields: {
   *       reviews: "ReviewService",
   *       dimensions: "ShippingService",
   *       weight: "ShippingService"
   *     }
   *   }
   * }
   */

  /**
   * XXX I want to rename this map to something that feels more directionally intutitive:
   * typesMap
   * typeToServiceMap
   * typeWithExtensionsMap
   * typeWithExtensionsToServiceMap
   */
  const serviceMap: {
    [typeName: string]: {
      serviceName?: ServiceName;
      extensionFields: { [fieldName: string]: string };
    };
  } = Object.create(null);

  for (const { typeDefs, name: serviceName } of services) {
    for (const definition of typeDefs.definitions) {
      if (
        (definition.kind === Kind.OBJECT_TYPE_DEFINITION ||
          definition.kind === Kind.OBJECT_TYPE_EXTENSION) &&
        definition.fields
      ) {
        // XXX casting out of ReadonlyArray
        (definition.fields as FieldDefinitionNode[]) = definition.fields.filter(
          field => findDirectivesOnTypeOrField(field, "external").length === 0
        );
      }
      if (isTypeDefinitionNode(definition)) {
        const typeName = definition.name.value;

        /**
         * This type is a base definition (not an extension). If this type is already in the serviceMap, then
         * 1. It was declared by a previous service, but this newer one takes precedence, or...
         * 2. It was extended by a service before declared
         */
        if (serviceMap[typeName]) {
          serviceMap[typeName].serviceName = serviceName;
        } else {
          serviceMap[typeName] = {
            serviceName,
            extensionFields: Object.create(null)
          };
        }

        /**
         * If this type already exists in the definitions map, push this definition to the array (newer defs
         * take precedence). If not, create the definitions array and add it to the definitionsMap.
         */
        if (definitionsMap[typeName]) {
          definitionsMap[typeName].push(definition);
        } else {
          definitionsMap[typeName] = [definition];
        }
      } else if (isTypeExtensionNode(definition)) {
        const typeName = definition.name.value;

        /**
         * This definition is an extension of an OBJECT type defined in another service.
         * TODO: handle extensions of non-object types?
         */
        if (
          definition.kind === Kind.OBJECT_TYPE_EXTENSION ||
          definition.kind === Kind.INPUT_OBJECT_TYPE_EXTENSION
        ) {
          if (!definition.fields) break;

          // XXX fix types
          // create map of { fieldName: serviceName } for each field.
          const fields = (definition.fields as any[]).reduce((prev, next) => {
            prev[next.name.value] = serviceName;
            return prev;
          }, Object.create(null));

          /**
           * If the type already exists in the serviceMap, add the extended fields. If not, create the object
           * and add the extensionFields, but don't add a serviceName. That will be added once that service
           * definition is processed.
           */
          if (serviceMap[typeName]) {
            serviceMap[typeName].extensionFields = {
              ...serviceMap[typeName].extensionFields,
              ...fields
            };
          } else {
            serviceMap[typeName] = { extensionFields: fields };
          }
        }

        if (definition.kind === Kind.ENUM_TYPE_EXTENSION) {
          if (!definition.values) break;

          const values = definition.values.reduce((prev, next) => {
            prev[next.name.value] = serviceName;
            return prev;
          }, Object.create(null));

          if (serviceMap[typeName]) {
            serviceMap[typeName].extensionFields = {
              ...serviceMap[typeName].extensionFields,
              ...values
            };
          } else {
            serviceMap[typeName] = { extensionFields: values };
          }
        }

        /**
         * If an extension for this type already exists in the extensions map, push this extension to the
         * array (since a type can be extended by multiple services). If not, create the extensions array
         * and add it to the extensionsMap.
         */
        if (extensionsMap[typeName]) {
          extensionsMap[typeName].push(definition);
        } else {
          extensionsMap[typeName] = [definition];
        }
      }
    }
  }

  /**
   * what if an extended type doesn't have a base type?
   * - Check each of the extensions, and see if there's a corresponding definition
   * - if so, do nothing. If not, create an empty definition with `null` as the serviceName
   */
  for (const extensionTypeName of Object.keys(extensionsMap)) {
    if (!definitionsMap[extensionTypeName]) {
      definitionsMap[extensionTypeName] = [
        {
          kind: Kind.OBJECT_TYPE_DEFINITION,
          name: { kind: Kind.NAME, value: extensionTypeName },
          fields: []
        }
      ];

      // ideally, the serviceName would be the first extending service, but there's not a reliable way
      // to trace the extensionNode back to a service.
      serviceMap[extensionTypeName].serviceName = null;
    }
  }

  // After mapping over each service/type we can build the new schema from nothing.
  let schema = new GraphQLSchema({
    query: undefined,
    directives: federationDirectives
  });

  // Extend the blank schema with the base type definitions

  const definitionsDocument = {
    kind: Kind.DOCUMENT,
    definitions: Object.values(definitionsMap).flat()
  };

  errors = validateSDL(definitionsDocument, schema);

  schema = extendSchema(schema, definitionsDocument, { assumeValidSDL: true });

  const extensionsDocument = {
    kind: Kind.DOCUMENT,
    definitions: Object.values(extensionsMap).flat()
  };

  errors.push(...validateSDL(extensionsDocument, schema));

  schema = extendSchema(schema, extensionsDocument, { assumeValidSDL: true });

  /**
   * Extend each type in the GraphQLSchema we built with its `baseServiceName` (the owner of the base type)
   * For each field in those types, we do the same: add the name of the service that extended the base type
   * to add that field (the `extendingServiceName`)
   */
  for (const [
    typeName,
    { serviceName: baseServiceName, extensionFields }
  ] of Object.entries(serviceMap)) {
    // A named type can be any one of:
    // ObjectType, InputObjectType, EnumType, UnionType, InterfaceType, ScalarType
    const namedType = schema.getType(typeName) as GraphQLNamedType;
    namedType.federation = {
      ...namedType.federation,
      serviceName: baseServiceName
    };

    if (isObjectType(namedType)) {
      const keyDirectives = findDirectivesOnTypeOrField(
        namedType.astNode,
        "key"
      );

      namedType.federation = {
        ...namedType.federation,
        keys: keyDirectives
          ? keyDirectives
              .map(keyDirective =>
                keyDirective.arguments &&
                isStringValueNode(keyDirective.arguments[0].value)
                  ? parseSelections(keyDirective.arguments[0].value.value)
                  : null
              )
              .filter(isNotNullOrUndefined)
          : []
      };

      for (const field of Object.values(namedType.getFields())) {
        // TODO: validation error if rest.length > 0
        const [providesDirective, ...rest] = findDirectivesOnTypeOrField(
          field.astNode,
          "provides"
        );

        if (
          providesDirective &&
          providesDirective.arguments &&
          isStringValueNode(providesDirective.arguments[0].value)
        ) {
          field.federation = {
            ...field.federation,
            provides: parseSelections(
              providesDirective.arguments[0].value.value
            )
          };
        }
      }
    }

    for (const [fieldName, extendingServiceName] of Object.entries(
      extensionFields
    )) {
      if (isObjectType(namedType)) {
        const field = namedType.getFields()[fieldName];
        field.federation = {
          ...field.federation,
          serviceName: extendingServiceName
        };

        // TODO: validation error if rest.length > 0
        const [requiresDirective, ...rest] = findDirectivesOnTypeOrField(
          field.astNode,
          "requires"
        );

        if (
          requiresDirective &&
          requiresDirective.arguments &&
          isStringValueNode(requiresDirective.arguments[0].value)
        ) {
          field.federation = {
            ...field.federation,
            requires: parseSelections(
              requiresDirective.arguments[0].value.value
            )
          };
        }
      }

      // We don't need these at all
      // if (isInputObjectType(namedType) || isInterfaceType(namedType)) {
      //   const field = namedType.getFields()[fieldName];
      //   field.serviceName = extendingServiceName;
      // }

      // TODO: We want to throw warnings for this
      // if (isEnumType(namedType)) {
      //   const enumValue = namedType
      //     .getValues()
      //     .find(value => value.name === fieldName);

      //   if (enumValue) {
      //     enumValue.serviceName = extendingServiceName;
      //   }
      // }

      // if (isUnionType(namedType)) {
      //   // TODO
      //   // can you extend a union type?
      // }

      // if (isScalarType(namedType)) {
      //   // TODO
      // }
    }
  }

  /**
   * At the end, we're left with a full GraphQLSchema that _also_ has `serviceName` fields for every type,
   * and every field that was extended. Fields that were _not_ extended (added on the base type by the owner),
   * there is no `serviceName`, and we should refer to the type's `serviceName`
   */
  return { schema, errors };
}
