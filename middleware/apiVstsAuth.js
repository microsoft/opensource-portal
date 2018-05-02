//
// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

'use strict';

const request = require('requestretry');

const jsonError = require('./jsonError');

// TODO: consider better caching
const localMemoryCacheVstsToAadId = new Map();

module.exports = function vstsAuthMiddleware(req, res, next) {
  const config = req.app.settings.runtimeConfig;
  if (!config) {
    return next(new Error('Missing configuration for the application'));
  }
  if (!config.authentication || !config.authentication.vsts) {
    return next(new Error('No VSTS authentication configuration available, VSTS authentication is not supported'));
  }
  if (config.authentication.vsts.enabled !== true) {
    return next(new Error('VSTS authentication is not enabled in the current configuration'));
  }
  if (!config.authentication.vsts.vstsCollectionUrl) {
    return next(new Error('VSTS collection URL is missing in the environment configuration'));
  }

  const mailAddressProvider = req.app.settings.providers.mailAddressProvider;
  if (!mailAddressProvider.getIdFromUpn) {
    return next(new Error('The mailAddressProvider provider must expose an identity resolver function to work in this feature'));
  }

  const vstsCollectionUrl = config.authentication.vsts.vstsCollectionUrl;
  const connectionDataApi = `${vstsCollectionUrl}/_apis/connectiondata`;
  const authorizationHeader = req.headers.authorization;

  function translateVstsUpnToAadId(upn, callback) {
    let cached = localMemoryCacheVstsToAadId.get(upn);
    if (cached) {
      return callback(null, cached);
    }
    return mailAddressProvider.getIdFromUpn(upn, (error, id) => {
      if (error) {
        return callback(error);
      }
      localMemoryCacheVstsToAadId.set(upn, id);
      return callback(null, id);
    });
  }

  request(connectionDataApi, {
    json: true,
    headers: {
      'Authorization': authorizationHeader,
      'X-TFS-FedAuthRedirect': 'Suppress',
    },
  }, (error, response, body) => {
    if (!error && response.statusCode === 200) {

      if (!body.authenticatedUser || !body.authenticatedUser.isActive) {
        error = jsonError('The user is no longer active or authenticated', 401);
        error.authErrorMessage = error.message;
        return next(error);
      }

      const displayName = body.authenticatedUser.providerDisplayName || 'Authenticated User';

      if (!body.authenticatedUser.properties || !body.authenticatedUser.properties.Account) {
        error = jsonError('Authenticated user information is not available from VSTS', 401);
        error.authErrorMessage = error.message;
        return next(error);
      }

      if (body.authenticatedUser.properties.Account['$type'] !== 'System.String') {
        error = jsonError('Authenticated user type from VSTS is not supported', 401);
        error.authErrorMessage = error.message;
        return next(error);
      }

      const upn = body.authenticatedUser.properties.Account['$value'];

      return translateVstsUpnToAadId(upn, (error, id) => {
        if (error) {
          return next(error);
        }
        // IMPORTANT: for our use in the extension, apiKeyRow.owner is an AAD ID and is
        // the primary way to make sure things are good for now...
        req.apiKeyRow = {
          owner: id,
          service: 'vsts-pat',
          description: `VSTS Personal Access Token for ${displayName}`,
          displayName: displayName,
          upn: upn,
          apis: 'extension,links', // only access to these APIs for now
        };
        req.apiKeyRowProvider = 'vsts';
        return next();
      });
    } else {
      const error = jsonError(`You are not authorized to access ${vstsCollectionUrl}`, 401);
      error.authErrorMessage = error.message;
      return next(error);
    }
  });
};
