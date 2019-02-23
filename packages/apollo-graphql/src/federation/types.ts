import {
  SelectionNode,
  DocumentNode,
  GraphQLSchema,
  GraphQLError
} from "graphql";
import { SDLValidationRule } from "graphql/validation/ValidationContext";

export type ServiceName = string | null;

export interface FederationType {
  serviceName?: ServiceName;
  keys?: ReadonlyArray<SelectionNode>[];
}

export interface FederationField {
  serviceName?: ServiceName;
  requires?: ReadonlyArray<SelectionNode>;
  provides?: ReadonlyArray<SelectionNode>;
}

export interface ServiceDefinition {
  typeDefs: DocumentNode;
  name: string;
}

declare module "graphql/validation/validate" {
  function validateSDL(
    documentAST: DocumentNode,
    schemaToExtend?: GraphQLSchema | null,
    rules?: ReadonlyArray<SDLValidationRule>
  ): GraphQLError[];
}

declare module "graphql/type/definition" {
  interface GraphQLObjectType {
    federation?: FederationType;
  }

  interface GraphQLEnumType {
    federation?: FederationType;
  }

  interface GraphQLScalarType {
    federation?: FederationType;
  }

  interface GraphQLInterfaceType {
    federation?: FederationType;
  }

  interface GraphQLUnionType {
    federation?: FederationType;
  }

  interface GraphQLInputObjectType {
    federation?: FederationType;
  }

  interface GraphQLEnumValue {
    federation?: FederationType;
  }

  interface GraphQLInputField {
    federation?: FederationField;
  }

  interface GraphQLField<TSource, TContext> {
    federation?: FederationField;
  }
}
