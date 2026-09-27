export interface ParsedApiGrant {
  capabilityId: string;
  bindingId: string;
  apiId: string;
  endpoints: Array<{ endpointId: string }>;
  allEndpoints: boolean;
}

export interface ParsedMcpGrant {
  capabilityId: string;
  bindingId: string;
  serverId: string;
  tools: Array<{ toolName: string }>;
  allTools: boolean;
}

// A task's API capability grants are promoted to virtual tools ONLY through the
// binding-aware grant path in agentTurn (`mapGrantedEndpointsToToolSpecs`), which
// namespaces each tool by its bindingId (`api:<bindingId>/<endpoint>`) and pins
// `api.http.call`'s bindingId to the run's connection. They are deliberately NOT
// merged into `coreApis`: that path is apiId-namespaced and carries no bindingId,
// so it would promote an UNPINNED duplicate (`api:<apiId>/<endpoint>`) that
// scope-resolves an arbitrary binding when a space has more than one for the apiId
// — the exact multi-account drift the pinned grant path exists to prevent.
