import {
  ObjectTypeDefinitionNode,
  FieldDefinitionNode,
  Kind,
  StringValueNode,
  parse,
  OperationDefinitionNode
} from "graphql";
import Maybe from "graphql/tsutils/Maybe";

export function isStringValueNode(node: any): node is StringValueNode {
  return node.kind === Kind.STRING;
}

export function isNotNullOrUndefined<T>(
  value: T | null | undefined
): value is T {
  return value !== null && typeof value !== "undefined";
}

export function findDirectivesOnTypeOrField(
  node: Maybe<ObjectTypeDefinitionNode | FieldDefinitionNode>,
  directiveName: string
) {
  return node && node.directives
    ? node.directives.filter(
        directive => directive.name.value === directiveName
      )
    : [];
}

export function parseSelections(source: string) {
  return (parse(`query { ${source} }`)
    .definitions[0] as OperationDefinitionNode).selectionSet.selections;
}
