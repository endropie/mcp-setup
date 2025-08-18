import { SafeParseReturnType, Schema, z } from 'zod';
import { Tool as SDKTool } from '@modelcontextprotocol/sdk/types.js';
import { ImageContent } from '../transports/utils/image-handler.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { jsonSchemaToZod } from 'json-schema-to-zod';

export type InputSchemaProperties = {
  [K in string]: {
    [key: string]: any
    type: 'string';
    description: string;
  }
};

export type ToolSchema<T> = {
  [K in keyof T]: {
    type: z.ZodType<T[K]>;
    description: string;
  };
};

export type ToolInput<T extends ToolSchema<any>> = {
  [K in keyof T]: z.infer<T[K]['type']>;
};

// Type helper to infer input type from schema
export type InferSchemaType<TSchema> =
  TSchema extends z.ZodObject<any>
    ? z.infer<TSchema>
    : TSchema extends ToolSchema<infer T>
      ? T
      : never;

// Magic type that infers from the schema property of the current class
export type MCPInput<T extends MCPTool<any, any> = MCPTool<any, any>> = InferSchemaType<
  T['schema']
>;

export type TextContent = {
  type: 'text';
  text: string;
  mimeType?: string;
};

export type ErrorContent = {
  type: 'error';
  text: string;
};

export type AudioContent = {
  type: 'audio';
  data: string;
  mimeType: string;
};

export type ResourceLinkContent = {
  type: 'resource_link';
  uri: string;
  name: string;
  description: string;
  mimeType: string;
};

export type EmbeddingResourceContent = {
  type: 'resource';
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export type ToolContent = TextContent | ImageContent | AudioContent | ResourceLinkContent | EmbeddingResourceContent | ErrorContent;

export type ToolResponse = {
  content: ToolContent[];
  isError?: boolean; 
};

export interface ToolProtocol extends SDKTool {
  name: string;
  description: string;
  toolDefinition: {
    name: string;
    description: string;
    inputSchema: {
      type: 'object';
      properties?: InputSchemaProperties;
      required?: string[];
    };
  };
  toolCall(request: {
    params: { name: string; arguments?: Record<string, unknown> };
  }): Promise<ToolResponse>;
}

/**
 * Base class for MCP tools using Zod schemas for input validation and type inference.
 *
 * Define your tool schema using Zod with descriptions:
 * ```typescript
 * const schema = z.object({
 *   message: z.string().describe("The message to process")
 * });
 *
 * class MyTool extends MCPTool {
 *   name = "my_tool";
 *   description = "My tool description";
 *   schema = schema;
 *
 *   async execute(input: McpInput<this>) {
 *     // input is fully typed from your schema
 *     return input.message;
 *   }
 * }
 * ```
 */
export abstract class MCPTool<TInput extends Record<string, any> = any, TSchema = any>
  implements ToolProtocol
{
  abstract name: string;
  abstract description: string;
  protected abstract schema: TSchema extends z.ZodObject<any>
    ? TSchema
    : TSchema extends ToolSchema<any>
      ? TSchema
      : z.ZodObject<any> | ToolSchema<TInput>;
  protected useStringify: boolean = true;
  [key: string]: unknown;

  /**
   * Generates the tool definition compatible with the MCP client.
   * @returns {{name: string, description: string, inputSchema: {type: string, properties?: Record<string, unknown>, required?: string[]}}}
   * @internal
   */
  get toolDefinition(): ToolProtocol['toolDefinition'] {
    return {
      name: this.name,
      description: this.description,
      inputSchema: this.inputSchema,
    };
  }

  /**
   * Generates the MCP-compliant input schema from the tool schema.
   * @internal
   */
  get inputSchema(): ToolProtocol['toolDefinition']['inputSchema'] {
    if (this.isZodObject(this.schema)) {
      return this.generateSchemaFromZodObject(this.schema);
    } else {
      return this.generateSchemaFromLegacyFormat(this.schema as ToolSchema<TInput>);
    }
  }

  /**
   * Validates the tool schema. This is called automatically when the tool is registered
   * with an MCP server, but can also be called manually for testing.
   */
  public validate(): void {
    if (this.isZodObject(this.schema)) {
      // Access inputSchema to trigger validation
      const _ = this.inputSchema;
    }
  }

  private isZodObject(schema: unknown): schema is z.ZodObject<any> {    
    return schema instanceof z.ZodObject 
    || (
      schema !== null &&
      typeof schema === 'object' &&
      typeof (schema as any).parse === "function" && 
      (schema as any)._def?.typeName === 'ZodObject'
    );
  }

  private isZodType(type: unknown): boolean {
    return typeof type === "object" && type !== null && typeof (type as any).parse === "function";
  }

  private generateSchemaFromZodObject(zodSchema: z.ZodObject<any>): ToolProtocol['toolDefinition']['inputSchema'] {
    const newSchema = zodToJsonSchema(zodSchema) as ToolProtocol['toolDefinition']['inputSchema'];
    
    // Check for missing descriptions
    const missingDescriptions = Object.entries(newSchema.properties || {})
      .filter(([key, value]) => value.description === undefined)
      .map(([key]) => key);

    if (missingDescriptions.length > 0) {
      throw new Error(
        `Missing descriptions for fields in ${this.name}: ${missingDescriptions.join(', ')}. ` +
          `All fields must have descriptions when using Zod object schemas. ` +
          `Use .describe() on each field, e.g., z.string().describe("Field description")`
      );
    }

    return newSchema;
  }

  private generateSchemaFromLegacyFormat(schema: ToolSchema<TInput>): ToolProtocol['toolDefinition']['inputSchema'] {
    const properties: InputSchemaProperties = {};
    const required: string[] = [];

    Object.entries(schema).forEach(([key, fieldSchema]) => {
      // Determine the correct JSON schema type (unwrapping optional if necessary)
      if(this.isZodType(fieldSchema.type)) {

        const parsedSchema = (zodToJsonSchema(fieldSchema.type) as any)?.anyOf
          ? (zodToJsonSchema(fieldSchema.type) as any).anyOf[1]
          : zodToJsonSchema(fieldSchema.type);

        fieldSchema.required = fieldSchema.type.isOptional() ? false : true;
        properties[key] = { ...fieldSchema, ...parsedSchema };
        if (properties[key].$schema) delete properties[key].$schema;
        if (typeof properties[key].required !== 'undefined') delete properties[key].required;
      }
      // If the field is not an object, use the default JSON schema type
      else {
        const jsonType = this.getJsonSchemaType(fieldSchema.type);
        properties[key] = {
          ...fieldSchema,
          type: jsonType,
          description: fieldSchema.description,
        };
      }

      // If the field is required, add it to the required array.
      if (fieldSchema.required) {
        required.push(key);

      }
      
    });

    return {
      type: 'object',
      properties,
      required,
    };
  }

  protected abstract execute(
    input: TSchema extends z.ZodObject<any> ? z.infer<TSchema> : TInput
  ): Promise<unknown>;

  async toolCall(request: {
    params: { name: string; arguments?: Record<string, unknown> };
  }): Promise<ToolResponse> {
    try {
      const args = request.params.arguments || {};
      const inputValidated = await this.validateInput(args);

      if (!inputValidated.success) {
        return this.createErrorResponse(
          new Error(`Input validation failed: ${inputValidated.error.errors.map((err) => `${err.path.join('.')} - ${err.message}`).join(', ')}`)
        );
      }

      const result = await this.execute(
        inputValidated.data as TSchema extends z.ZodObject<any> ? z.infer<TSchema> : TInput
      );
      return this.createSuccessResponse(result);
    } catch (error) {
      return this.createErrorResponse(error as Error);
    }
  }

  private async validateInput(args: Record<string, unknown>): Promise<SafeParseReturnType<TInput, unknown>> {
    
    const zodSchema = this.isZodObject(this.schema) ? this.schema : z.object(
      Object.fromEntries(
        Object.entries(this.schema as ToolSchema<TInput>).map(([key, schema]) => {
          if (this.isZodType(schema.type)) return [key, schema.type];
          else {

            let schemaZod = eval(jsonSchemaToZod(schema)) as unknown as z.ZodType<any>;
            if (!(schema.required === true)) {
              schemaZod = schemaZod.optional();
            }
            return [key, schemaZod]
          }
        })
      )
    );
      
    const result = zodSchema.safeParse(args);

    return result as SafeParseReturnType<TInput, unknown>;
  }

  private getJsonSchemaType(val: z.ZodType<any> | string): string {
    if (typeof val === 'string') return val;
    // Unwrap optional types to correctly determine the JSON schema type.
    let currentType = val;
    if (currentType instanceof z.ZodOptional) {
      currentType = currentType.unwrap();
    }

    if (currentType instanceof z.ZodString) return 'string';
    if (currentType instanceof z.ZodNumber) return 'number';
    if (currentType instanceof z.ZodBoolean) return 'boolean';
    if (currentType instanceof z.ZodArray) return 'array';
    if (currentType instanceof z.ZodObject) return 'object';
    return 'string';
  }

  protected createSuccessResponse(data: unknown): ToolResponse {

    if (Array.isArray(data)) {
      const content = data.filter((item) => this.isValidContent(item)) as ToolContent[];
      if (content.length > 0) {
        return {
          content,
        };
      }
    }

    if (this.isValidContent(data)) {
      return {
        content: [data],
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: this.useStringify ? JSON.stringify(data) : String(data),
        },
      ],
    };
  }

  protected createErrorResponse(error: Error): ToolResponse {
    return {
      content: [{ type: 'text', text: error.message }],
      isError: true,
    };
  }

  /**
   * Check if the content is text
   * 
   * @param data - The content to check
   * 
   * @example 
   * {
        "type": "text",
        "text": "Hello, world!"
      }
   *  
   * @returns True if the content is text, false otherwise
   *  
   */
  private isTextContent(data: unknown): data is TextContent {
    return (
      typeof data === 'object' &&
      data !== null &&
      'type' in data &&
      data.type === 'text' &&
      'text' in data &&
      typeof (data as TextContent).text === 'string'
    );
  }

  /**
   * Check if the content is an image
   * 
   * @param data - The content to check
   * 
   * @example 
   * {
        "type": "image",
        "data": "iVBORw0KGgoAAAANSUhEUgAAAAUAAAAFCAYAAACNbyblAAAAHElEQVQI12P4//8/w38GIAXDIBKE0DHxgljNBAAO9TXL0Y4OHwAAAABJRU5ErkJggg==",
        "mimeType": "image/png"
      }
   *  
   * @returns True if the content is an image, false otherwise
   *  
   */
  private isImageContent(data: unknown): data is ImageContent {
    return (
      typeof data === 'object' &&
      data !== null &&
      'type' in data &&
      data.type === 'image' &&
      'data' in data &&
      'mimeType' in data &&
      typeof (data as ImageContent).data === 'string' &&
      typeof (data as ImageContent).mimeType === 'string'
    );
  }

  /**
   * Check if the content is audio
   * 
   * @param data - The content to check
   * 
   * @example 
   * {
        "type": "audio",
        "data": "base64-encoded-audio-data",
        "mimeType": "audio/mpeg"
      }
   *  
   * @returns True if the content is audio, false otherwise
   *  
   */
  private isAudioContent(data: unknown): data is AudioContent {
    return (
      typeof data === 'object' &&
      data !== null &&
      'type' in data &&
      data.type === 'audio' &&
      'data' in data &&
      'mimeType' in data &&
      typeof (data as AudioContent).data === 'string' &&
      typeof (data as AudioContent).mimeType === 'string'
    );
  }

  /**
   * Check if the content is a resource link
   * 
   * @param data - The content to check
   * 
   * @example 
   * {
        "type": "resource_link",
        "uri": "file:///project/src/main.rs",
        "name": "main.rs",
        "description": "Primary application entry point",
        "mimeType": "text/x-rust",
        "annotations": {
          "audience": ["assistant"],
          "priority": 0.9
        }
      }
   * 
   * @returns True if the content is a resource link, false otherwise
   */

  private isResourceLinkContent(data: unknown): data is ResourceLinkContent {
    return (
      typeof data === 'object' &&
      data !== null &&
      'type' in data &&
      data.type === 'resourceLink' &&
      'uri' in data &&
      typeof (data as ResourceLinkContent).uri === 'string'
    );
  }

  /**
   * Check if the content is an array of valid content
   * 
   * @param data - The content to check
   * 
   * @example 
   * {
        "type": "resource",
        "resource": {
          "uri": "file:///project/src/main.rs",
          "title": "Project Rust Main File",
          "mimeType": "text/x-rust",
          "text": "fn main() {\n    println!(\"Hello world!\");\n}",
        }
      }

   * @returns true if the content is an array of valid content
   */
  private isResourceContent(data: unknown): data is EmbeddingResourceContent {
    return (
      typeof data === 'object' &&
      data !== null &&
      'content' in data &&
      Array.isArray((data as ToolResponse).content) &&
      (data as ToolResponse).content.every((item) => this.isValidContent(item))
    );
  }

  private isErrorContent(data: unknown): data is ErrorContent {
    return (
      typeof data === 'object' &&
      data !== null &&
      'type' in data &&
      data.type === 'error' &&
      'text' in data &&
      typeof (data as ErrorContent).text === 'string'
    );
  }

  private isValidContent(data: unknown): data is ToolContent {

    return this.isImageContent(data) 
      || this.isTextContent(data) 
      || this.isAudioContent(data) 
      || this.isResourceLinkContent(data)
      || this.isResourceContent(data)
      || this.isErrorContent(data);
  }

  protected async fetch<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, init);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return response.json();
  }
}

/**
 * Helper function to define tool schemas with required descriptions.
 * This ensures all fields have descriptions at build time.
 *
 * @example
 * const schema = defineSchema({
 *   name: z.string().describe("User's name"),
 *   age: z.number().describe("User's age")
 * });
 */
export function defineSchema<T extends z.ZodRawShape>(shape: T): z.ZodObject<T> {
  // Check descriptions at runtime during development
  if (process.env.NODE_ENV !== 'production') {
    for (const [key, value] of Object.entries(shape)) {
      let schema = value;
      let hasDescription = false;

      // Check the schema and its wrapped versions for description
      while (schema && typeof schema === 'object') {
        if ('_def' in schema && schema._def?.description) {
          hasDescription = true;
          break;
        }
        // Check wrapped types
        if (
          schema instanceof z.ZodOptional ||
          schema instanceof z.ZodDefault ||
          schema instanceof z.ZodNullable
        ) {
          schema = schema._def.innerType || (schema as any).unwrap();
        } else {
          break;
        }
      }

      if (!hasDescription) {
        throw new Error(
          `Field '${key}' is missing a description. Use .describe() to add one.\n` +
            `Example: ${key}: z.string().describe("Description for ${key}")`
        );
      }
    }
  }

  return z.object(shape);
}
