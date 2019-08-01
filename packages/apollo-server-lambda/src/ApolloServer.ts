import {
  APIGatewayProxyCallback,
  APIGatewayProxyEvent,
  Context as LambdaContext,
} from 'aws-lambda';
import {
  ApolloServerBase,
  GraphQLOptions,
  Config,
  FileUploadOptions,
  formatApolloErrors,
  processFileUploads,
} from 'apollo-server-core';
import {
  renderPlaygroundPage,
  RenderPageOptions as PlaygroundRenderPageOptions,
} from '@apollographql/graphql-playground-html';
import stream from 'stream';

import { graphqlLambda } from './lambdaApollo';
import { Headers } from 'apollo-server-env';

export interface CreateHandlerOptions {
  cors?: {
    origin?: boolean | string | string[];
    methods?: string | string[];
    allowedHeaders?: string | string[];
    exposedHeaders?: string | string[];
    credentials?: boolean;
    maxAge?: number;
  };
  async?: boolean;
  uploadsConfig?: FileUploadOptions;
}

export class ApolloServer extends ApolloServerBase {
  // If you feel tempted to add an option to this constructor. Please consider
  // another place, since the documentation becomes much more complicated when
  // the constructor is not longer shared between all integration
  constructor(options: Config) {
    if (process.env.ENGINE_API_KEY || options.engine) {
      options.engine = {
        sendReportsImmediately: true,
        ...(typeof options.engine !== 'boolean' ? options.engine : {}),
      };
    }
    super(options);
  }

  // This translates the arguments from the middleware into graphQL options It
  // provides typings for the integration specific behavior, ideally this would
  // be propagated with a generic to the super class
  createGraphQLServerOptions(
    event: APIGatewayProxyEvent,
    context: LambdaContext,
  ): Promise<GraphQLOptions> {
    return super.graphQLServerOptions({ event, context });
  }

  public createHandler(
    { cors, async, uploadsConfig }: CreateHandlerOptions = {
      cors: undefined,
      async: false,
      uploadsConfig: undefined,
    },
  ) {
    // We will kick off the `willStart` event once for the server, and then
    // await it before processing any requests by incorporating its `await` into
    // the GraphQLServerOptions function which is called before each request.
    const promiseWillStart = this.willStart();

    const corsHeaders = new Headers();

    if (cors) {
      if (cors.methods) {
        if (typeof cors.methods === 'string') {
          corsHeaders.set('access-control-allow-methods', cors.methods);
        } else if (Array.isArray(cors.methods)) {
          corsHeaders.set(
            'access-control-allow-methods',
            cors.methods.join(','),
          );
        }
      }

      if (cors.allowedHeaders) {
        if (typeof cors.allowedHeaders === 'string') {
          corsHeaders.set('access-control-allow-headers', cors.allowedHeaders);
        } else if (Array.isArray(cors.allowedHeaders)) {
          corsHeaders.set(
            'access-control-allow-headers',
            cors.allowedHeaders.join(','),
          );
        }
      }

      if (cors.exposedHeaders) {
        if (typeof cors.exposedHeaders === 'string') {
          corsHeaders.set('access-control-expose-headers', cors.exposedHeaders);
        } else if (Array.isArray(cors.exposedHeaders)) {
          corsHeaders.set(
            'access-control-expose-headers',
            cors.exposedHeaders.join(','),
          );
        }
      }

      if (cors.credentials) {
        corsHeaders.set('access-control-allow-credentials', 'true');
      }
      if (typeof cors.maxAge === 'number') {
        corsHeaders.set('access-control-max-age', cors.maxAge.toString());
      }
    }

    return (
      event: APIGatewayProxyEvent,
      context: LambdaContext,
      callback: APIGatewayProxyCallback = () => {},
    ) => {
      // We re-load the headers into a Fetch API-compatible `Headers`
      // interface within `graphqlLambda`, but we still need to respect the
      // case-insensitivity within this logic here, so we'll need to do it
      // twice since it's not accessible to us otherwise, right now.
      const eventHeaders = new Headers(event.headers);

      // Make a request-specific copy of the CORS headers, based on the server
      // global CORS headers we've set above.
      const requestCorsHeaders = new Headers(corsHeaders);

      if (cors && cors.origin) {
        const requestOrigin = eventHeaders.get('origin');
        if (typeof cors.origin === 'string') {
          requestCorsHeaders.set('access-control-allow-origin', cors.origin);
        } else if (
          requestOrigin &&
          (typeof cors.origin === 'boolean' ||
            (Array.isArray(cors.origin) &&
              requestOrigin &&
              cors.origin.includes(requestOrigin)))
        ) {
          requestCorsHeaders.set('access-control-allow-origin', requestOrigin);
        }

        const requestAccessControlRequestHeaders = eventHeaders.get(
          'access-control-request-headers',
        );
        if (!cors.allowedHeaders && requestAccessControlRequestHeaders) {
          requestCorsHeaders.set(
            'access-control-allow-headers',
            requestAccessControlRequestHeaders,
          );
        }
      }

      // Convert the `Headers` into an object which can be spread into the
      // various headers objects below.
      // Note: while Object.fromEntries simplifies this code, it's only currently
      //       supported in Node 12 (we support >=6)
      const requestCorsHeadersObject = Array.from(requestCorsHeaders).reduce<
        Record<string, string>
      >((headersObject, [key, value]) => {
        headersObject[key] = value;
        return headersObject;
      }, {});

      if (event.httpMethod === 'OPTIONS') {
        const result = {
          body: '',
          statusCode: 204,
          headers: {
            ...requestCorsHeadersObject,
          },
        };

        if (async) {
          return Promise.resolve(result);
        } else {
          context.callbackWaitsForEmptyEventLoop = false;
          return callback(null, result);
        }
      }

      if (this.playgroundOptions && event.httpMethod === 'GET') {
        const acceptHeader = event.headers['Accept'] || event.headers['accept'];
        if (acceptHeader && acceptHeader.includes('text/html')) {
          const path =
            event.path ||
            (event.requestContext && event.requestContext.path) ||
            '/';

          const playgroundRenderPageOptions: PlaygroundRenderPageOptions = {
            endpoint: path,
            ...this.playgroundOptions,
          };

          const result = {
            body: renderPlaygroundPage(playgroundRenderPageOptions),
            statusCode: 200,
            headers: {
              'Content-Type': 'text/html',
              ...requestCorsHeadersObject,
            },
          };

          if (async) {
            return Promise.resolve(result);
          } else {
            return callback(null, result);
          }
        }
      }

      if (!async) {
        // Maintain existing behavior
        context.callbackWaitsForEmptyEventLoop = false;
      }

      const resultPromise = promiseWillStart.then(async () => {
        // TODO - This should be replaced with something which can have the
        // 'finish'/'close' event emit, since `graphql-upload` uses that in
        // order to release resources
        const response = new stream.Writable() as any;

        try {
          event.body = await this.handleFileUploads(
            event,
            eventHeaders,
            response,
            uploadsConfig || {},
          ) as any;
        } catch (error) {
          throw formatApolloErrors([error], {
            formatter: this.requestOptions.formatError,
            debug: this.requestOptions.debug,
          });
        }

        const options = await this.createGraphQLServerOptions(event, context);
        const result = await graphqlLambda(options)(event, context);

        // TODO - Close response here so resources are released

        return (
          result && {
            ...result,
            headers: {
              ...result.headers,
              ...requestCorsHeadersObject,
            },
          }
        );
      });

      if (async) {
        return resultPromise;
      } else {
        resultPromise
          .then(result => {
            callback(null, result);
          })
          .catch(error => {
            callback(error);
          });
      }
    };
  }

  // This integration supports file uploads.
  protected supportsUploads(): boolean {
    return true;
  }

  // If file uploads are detected, prepare them for easier handling with
  // the help of `graphql-upload`.
  private async handleFileUploads(
    event: APIGatewayProxyEvent,
    headers: Headers,
    response: any,
    uploadsConfig: FileUploadOptions,
  ) {
    if (typeof processFileUploads !== 'function' || event.body === null) {
      return event.body;
    }

    const contentType = headers.get('content-type');

    if (contentType && contentType.startsWith('multipart/form-data')) {
      const request = new stream.Readable() as any;
      request.push(
        Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'ascii'),
      );
      request.push(null);
      request.headers = event.headers;
      request.headers['content-type'] = contentType;

      return processFileUploads(request, response, uploadsConfig);
    }

    return event.body;
  }
}
