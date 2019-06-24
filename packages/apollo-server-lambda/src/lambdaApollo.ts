import {GraphQLOptions, HttpQueryError, runHttpQuery,} from 'apollo-server-core';
import {Headers, ValueOrPromise} from 'apollo-server-env';
import lambda from 'aws-lambda';

export interface LambdaGraphQLOptionsFunction {
  (event: lambda.APIGatewayProxyEvent,
   context: lambda.Context): ValueOrPromise<GraphQLOptions>;
}

export function graphqlLambda(
    options: GraphQLOptions|LambdaGraphQLOptionsFunction,
    ): lambda.APIGatewayProxyHandler {
  if (!options) {
    throw new Error('Apollo Server requires options.');
  }

  if (arguments.length > 1) {
    throw new Error(
        `Apollo Server expects exactly one argument, got ${arguments.length}`,
    );
  }

  const graphqlHandler: lambda.APIGatewayProxyHandler = (
      event,
      context,
      callback,
      ): void => {
    context.callbackWaitsForEmptyEventLoop = false;

    if (event.httpMethod === 'POST' && !event.body) {
      return callback(null, {
        body: 'POST body missing.',
        statusCode: 500,
      });
    }
    runHttpQuery([event, context], {
      method: event.httpMethod,
      options: options,
      query: event.httpMethod === 'POST' && event.body ?
          JSON.parse(event.body) :
          event.queryStringParameters,
      request: {
        url: event.path,
        method: event.httpMethod,
        headers: new Headers(event.headers),
      },
    })
        .then(
            ({graphqlResponse, responseInit}) => {
              callback(null, {
                body: graphqlResponse,
                statusCode: 200,
                headers: responseInit.headers,
              });
            },
            (error: HttpQueryError) => {
              if ('HttpQueryError' !== error.name) return callback(error);
              callback(null, {
                body: error.message,
                statusCode: error.statusCode,
                headers: error.headers,
              });
            },
        );
  };

  return graphqlHandler;
}

export function graphqlLambdaAsync(options: GraphQLOptions):
    lambda.APIGatewayProxyHandler {
  if (!options) {
    throw new Error('Apollo Server requires options.');
  }

  if (arguments.length > 1) {
    throw new Error(
        `Apollo Server expects exactly one argument, got ${arguments.length}`,
    );
  }

  const graphqlHandler: lambda.APIGatewayProxyHandler =
      async(event, context): Promise<lambda.APIGatewayProxyResult> => {
    if (event.httpMethod === 'POST' && !event.body) {
      return {
        body: 'POST body missing.',
        statusCode: 500,
      };
    }
    try {
      const {graphqlResponse, responseInit} =
          await runHttpQuery([event, context], {
            method: event.httpMethod,
            options: options,
            query: event.httpMethod === 'POST' && event.body ?
                JSON.parse(event.body) :
                event.queryStringParameters,
            request: {
              url: event.path,
              method: event.httpMethod,
              headers: new Headers(event.headers),
            },
          })

      return {
        body: graphqlResponse,
        statusCode: 200,
        headers: responseInit.headers,
      };
    } catch (error) {
      if ('HttpQueryError' === error.name) {
        return {
          body: error.message,
          statusCode: error.statusCode,
          headers: error.headers,
        };
      } else {
        throw error;
      }
    }
  };

  return graphqlHandler;
}
