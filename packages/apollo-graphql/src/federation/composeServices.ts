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
  FieldDefinitionNode,
  InputValueDefinitionNode,
  DocumentNode
} from "graphql";
import { validateSDL } from "graphql/validation/validate";
import federationDirectives from "./directives";
import {
  findDirectivesOnTypeOrField,
  isStringValueNode,
  parseSelections,
  isNotNullOrUndefined,
  mapFieldNamesToServiceName,
  stripExternalFieldsFromTypeDefinition
} from "./utils";
import { ServiceDefinition, ServiceName } from "./types";

// Map of all definitions to eventually be passed to extendSchema
interface DefinitionsMap {
  [name: string]: TypeDefinitionNode[];
}
// Map of all extensions to eventually be passed to extendSchema
interface ExtensionsMap {
  [name: string]: TypeExtensionNode[];
}

/**
 * A map of base types to their owning service. Used by query planner to direct traffic.
 * This contains the base type's "owner". Any fields that extend this type in another service
 * are listed under "extensionFieldsToOwningServiceMap". extensionFieldsToOwningServiceMap are in the format { myField: my-service-name }
 *
 * Example resulting typeToServiceMap shape:
 *
 * const typeToServiceMap = {
 *   Product: {
 *     serviceName: "ProductService",
 *     extensionFieldsToOwningServiceMap: {
 *       reviews: "ReviewService", // Product.reviews comes from the ReviewService
 *       dimensions: "ShippingService",
 *       weight: "ShippingService"
 *     }
 *   }
 * }
 */
interface TypeToServiceMap {
  [typeName: string]: {
    serviceName?: ServiceName;
    extensionFieldsToOwningServiceMap: { [fieldName: string]: string };
  };
}

/**
 * Loop over each service and process its typeDefs (`definitions`)
 * - build up typeToServiceMap
 * - push individual definitions onto either definitionsMap or extensionsMap
 */
export function buildMapsFromServiceList(serviceList: [ServiceDefinition]) {
  const definitionsMap: DefinitionsMap = Object.create(null);
  const extensionsMap: ExtensionsMap = Object.create(null);
  const typeToServiceMap: TypeToServiceMap = Object.create(null);

  for (const { typeDefs, name: serviceName } of serviceList) {
    for (const definition of typeDefs.definitions) {
      // Remove all fields from definition with an @external directive
      stripExternalFieldsFromTypeDefinition(definition);

      if (isTypeDefinitionNode(definition)) {
        const typeName = definition.name.value;

        /**
         * This type is a base definition (not an extension). If this type is already in the typeToServiceMap, then
         * 1. It was declared by a previous service, but this newer one takes precedence, or...
         * 2. It was extended by a service before declared
         */
        if (typeToServiceMap[typeName]) {
          typeToServiceMap[typeName].serviceName = serviceName;
        } else {
          typeToServiceMap[typeName] = {
            serviceName,
            extensionFieldsToOwningServiceMap: Object.create(null)
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

          const fields = mapFieldNamesToServiceName<
            FieldDefinitionNode | InputValueDefinitionNode
          >(definition.fields, serviceName);

          /**
           * If the type already exists in the typeToServiceMap, add the extended fields. If not, create the object
           * and add the extensionFieldsToOwningServiceMap, but don't add a serviceName. That will be added once that service
           * definition is processed.
           */
          if (typeToServiceMap[typeName]) {
            typeToServiceMap[typeName].extensionFieldsToOwningServiceMap = {
              ...typeToServiceMap[typeName].extensionFieldsToOwningServiceMap,
              ...fields
            };
          } else {
            typeToServiceMap[typeName] = {
              extensionFieldsToOwningServiceMap: fields
            };
          }
        }

        if (definition.kind === Kind.ENUM_TYPE_EXTENSION) {
          if (!definition.values) break;

          const values = mapFieldNamesToServiceName(
            definition.values,
            serviceName
          );

          if (typeToServiceMap[typeName]) {
            typeToServiceMap[typeName].extensionFieldsToOwningServiceMap = {
              ...typeToServiceMap[typeName].extensionFieldsToOwningServiceMap,
              ...values
            };
          } else {
            typeToServiceMap[typeName] = {
              extensionFieldsToOwningServiceMap: values
            };
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

      // ideally, the serviceName would be the first extending service, but there's not a reliable way to
      // trace the extensionNode back to a service since each extension can be overwritten by other extensions
      typeToServiceMap[extensionTypeName].serviceName = null;
    }
  }

  return { typeToServiceMap, definitionsMap, extensionsMap };
}

function buildSchemaFromDefinitionsAndExtensions({
  definitionsMap,
  extensionsMap
}: {
  definitionsMap: DefinitionsMap;
  extensionsMap: ExtensionsMap;
}) {
  let errors: GraphQLError[] | undefined = undefined;
  let schema = new GraphQLSchema({
    query: undefined,
    directives: federationDirectives
  });

  // Extend the blank schema with the base type definitions (as an AST node)
  const definitionsDocument: DocumentNode = {
    kind: Kind.DOCUMENT,
    definitions: Object.values(definitionsMap).flat()
  };

  errors = validateSDL(definitionsDocument, schema);
  schema = extendSchema(schema, definitionsDocument, { assumeValidSDL: true });

  // Extend the schema with the extension definitions (as an AST node)
  const extensionsDocument: DocumentNode = {
    kind: Kind.DOCUMENT,
    definitions: Object.values(extensionsMap).flat()
  };

  errors.push(...validateSDL(extensionsDocument, schema));
  schema = extendSchema(schema, extensionsDocument, { assumeValidSDL: true });

  return { schema, errors };
}

/**
 * Using the typeToServiceMap, augment the passed in `schema` to add `federation` metadata to the types and
 * fields
 */
function addFederationMetadataToSchemaNodes({
  schema,
  typeToServiceMap
}: {
  schema: GraphQLSchema;
  typeToServiceMap: TypeToServiceMap;
}) {
  for (const [
    typeName,
    { serviceName: baseServiceName, extensionFieldsToOwningServiceMap }
  ] of Object.entries(typeToServiceMap)) {
    const namedType = schema.getType(typeName) as GraphQLNamedType;
    // Extend each type in the GraphQLSchema with the serviceName that owns it
    namedType.federation = {
      ...namedType.federation,
      serviceName: baseServiceName
    };

    /**
     * For object types, do 2 things
     * 1. add metadata for all the @key directives from the object type itself
     * 2. add metadata for all the @provides directives from its fields
     */
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
        const [providesDirective] = findDirectivesOnTypeOrField(
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

    /**
     * For extension fields, do 2 things:
     * 1. Add serviceName metadata to all fields that belong to a type extension
     * 2. add metadata from the @requires directive for each field extension
     */
    for (const [fieldName, extendingServiceName] of Object.entries(
      extensionFieldsToOwningServiceMap
    )) {
      // TODO: Why don't we need to check for non-object types here
      if (isObjectType(namedType)) {
        const field = namedType.getFields()[fieldName];
        field.federation = {
          ...field.federation,
          serviceName: extendingServiceName
        };

        const [requiresDirective] = findDirectivesOnTypeOrField(
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
    }
  }
}

export function composeServices(services: ServiceDefinition[]) {
  const {
    typeToServiceMap,
    definitionsMap,
    extensionsMap
  } = buildMapsFromServiceList(services);

  const { schema, errors } = buildSchemaFromDefinitionsAndExtensions({
    definitionsMap,
    extensionsMap
  });

  addFederationMetadataToSchemaNodes({
    schema,
    typeToServiceMap
  });

  /**
   * At the end, we're left with a full GraphQLSchema that _also_ has `serviceName` fields for every type,
   * and every field that was extended. Fields that were _not_ extended (added on the base type by the owner),
   * there is no `serviceName`, and we should refer to the type's `serviceName`
   */
  return { schema, errors };
}
