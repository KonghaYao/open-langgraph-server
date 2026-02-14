/**
 * @langchain/langgraph-sdk API 集成测试
 *
 * 这个测试展示了如何使用 LangGraph SDK 来对接 pure-graph server
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Client } from '@langchain/langgraph-sdk';
import { registerGraph } from '../../src/createEndpoint';
import http from 'http';
import { MessagesAnnotation } from '@langchain/langgraph';
import { AIMessage } from 'langchain';
import { handleRequest } from '../../src/adapter/fetch/index';

describe('LangGraph SDK 集成测试', () => {
    const prepareClient = () => {
        return new Client({
            apiUrl: '',
            callerOptions: {
                maxRetries: 0,
                fetch(url, init) {
                    return handleRequest(new Request(url, init));
                },
            },
        });
    };
    /**
     * 创建一个简单的测试图
     */
    const createSimpleGraph = async () => {
        const { StateGraph, START } = await import('@langchain/langgraph');

        const State = MessagesAnnotation;

        const simpleNode = (state: typeof State.State) => {
            return {
                messages: [...state.messages, new AIMessage("hello, I'm done")],
            };
        };

        return new StateGraph(State).addNode('simple', simpleNode).addEdge(START, 'simple').compile();
    };

    beforeAll(async () => {
        // 注册测试图
        const simpleGraph = await createSimpleGraph();
        registerGraph('test-simple', simpleGraph);
    });

    afterAll(async () => {});

    describe('Assistants API', () => {
        let client: ReturnType<typeof prepareClient>;

        beforeEach(() => {
            client = prepareClient();
        });

        describe('POST /assistants/search - Search Assistants', () => {
            it('should search all assistants without filters', async () => {
                const assistants = await client.assistants.search();
                expect(Array.isArray(assistants)).toBe(true);
                expect(assistants.length).toBeGreaterThan(0);
                expect(assistants[0]).toHaveProperty('assistant_id');
                expect(assistants[0]).toHaveProperty('graph_id');
                expect(assistants[0]).toHaveProperty('config');
                expect(assistants[0]).toHaveProperty('created_at');
                expect(assistants[0]).toHaveProperty('updated_at');
                expect(assistants[0]).toHaveProperty('metadata');
                expect(assistants[0]).toHaveProperty('version');
            });

            it('should search assistants by graphId', async () => {
                const assistants = await client.assistants.search({
                    graphId: 'test-simple',
                });
                expect(Array.isArray(assistants)).toBe(true);
                expect(assistants.length).toBe(1);
                expect(assistants[0].graph_id).toBe('test-simple');
                expect(assistants[0].assistant_id).toBe('test-simple');
            });

            it('should search assistants with limit', async () => {
                const assistants = await client.assistants.search({
                    limit: 1,
                });
                expect(assistants.length).toBeLessThanOrEqual(1);
            });

            it('should search assistants with offset', async () => {
                const allAssistants = await client.assistants.search();
                if (allAssistants.length > 1) {
                    const assistants = await client.assistants.search({
                        offset: 1,
                    });
                    expect(assistants.length).toBe(allAssistants.length - 1);
                }
            });

            it('should search assistants with sortBy', async () => {
                const assistants = await client.assistants.search({
                    sortBy: 'name',
                    sortOrder: 'asc',
                });
                expect(Array.isArray(assistants)).toBe(true);
                if (assistants.length > 1) {
                    expect(assistants[0].name).toBeLessThanOrEqual(assistants[1].name);
                }
            });
        });

        describe('POST /assistants/count - Count Assistants', () => {
            it('should count all assistants', async () => {
                const count = await client.assistants.count();
                expect(typeof count).toBe('number');
                expect(count).toBeGreaterThan(0);
            });

            it('should count assistants by graphId', async () => {
                const count = await client.assistants.count({
                    graphId: 'test-simple',
                });
                expect(typeof count).toBe('number');
                expect(count).toBe(1);
            });
        });

        describe('GET /assistants/{assistant_id} - Get Assistant', () => {
            it('should get assistant by ID', async () => {
                const assistant = await client.assistants.get('test-simple');
                expect(assistant).toHaveProperty('assistant_id', 'test-simple');
                expect(assistant).toHaveProperty('graph_id', 'test-simple');
                expect(assistant).toHaveProperty('config');
                expect(assistant).toHaveProperty('created_at');
                expect(assistant).toHaveProperty('updated_at');
                expect(assistant).toHaveProperty('metadata');
                expect(assistant).toHaveProperty('version');
                expect(assistant).toHaveProperty('name');
            });

            it('should throw error for non-existent assistant', async () => {
                await expect(client.assistants.get('non-existent-assistant')).rejects.toThrow();
            });
        });

        describe('DELETE /assistants/{assistant_id} - Delete Assistant', () => {
            it('should delete an assistant', async () => {
                // This test is a placeholder - the actual implementation
                // would need to support deleting assistants
                // await expect(client.assistants.delete('test-simple')).resolves.not.toThrow();
            });
        });

        describe('PATCH /assistants/{assistant_id} - Patch Assistant', () => {
            it('should update an assistant', async () => {
                // This test is a placeholder - the actual implementation
                // would need to support updating assistants
                // const updated = await client.assistants.update('test-simple', {
                //     name: 'Updated Name',
                // });
                // expect(updated).toHaveProperty('name', 'Updated Name');
            });
        });

        describe('GET /assistants/{assistant_id}/graph - Get Assistant Graph', () => {
            it('should get assistant graph', async () => {
                const graph = await client.assistants.getGraph('test-simple');
                expect(graph).toBeDefined();
                expect(typeof graph).toBe('object');
            });

            it('should get assistant graph with xray=false', async () => {
                const graph = await client.assistants.getGraph('test-simple', {
                    xray: false,
                });
                expect(graph).toBeDefined();
                expect(typeof graph).toBe('object');
            });

            it('should get assistant graph with xray=true', async () => {
                const graph = await client.assistants.getGraph('test-simple', {
                    xray: true,
                });
                expect(graph).toBeDefined();
                expect(typeof graph).toBe('object');
            });

            it('should get assistant graph with xray depth', async () => {
                const graph = await client.assistants.getGraph('test-simple', {
                    xray: 2,
                });
                expect(graph).toBeDefined();
                expect(typeof graph).toBe('object');
            });
        });

        // describe('GET /assistants/{assistant_id}/subgraphs - Get Assistant Subgraphs', () => {
        //     it('should get assistant subgraphs', async () => {
        //         const subgraphs = await client.assistants.getSubgraphs('test-simple');
        //         expect(subgraphs).toBeDefined();
        //     });

        //     it('should get assistant subgraphs with recurse=false', async () => {
        //         const subgraphs = await client.assistants.getSubgraphs('test-simple', {
        //             recurse: false,
        //         });
        //         expect(subgraphs).toBeDefined();
        //     });

        //     it('should get assistant subgraphs with recurse=true', async () => {
        //         const subgraphs = await client.assistants.getSubgraphs('test-simple', {
        //             recurse: true,
        //         });
        //         expect(subgraphs).toBeDefined();
        //     });
        // });

        // describe('GET /assistants/{assistant_id}/subgraphs/{namespace} - Get Assistant Subgraphs by Namespace', () => {
        //     it('should get assistant subgraphs by namespace', async () => {
        //         const subgraphs = await client.assistants.getSubgraphs('test-simple', {
        //             namespace: 'test-namespace',
        //         });
        //         expect(subgraphs).toBeDefined();
        //     });

        //     it('should get assistant subgraphs by namespace with recurse', async () => {
        //         const subgraphs = await client.assistants.getSubgraphs('test-simple', {
        //             namespace: 'test-namespace',
        //             recurse: true,
        //         });
        //         expect(subgraphs).toBeDefined();
        //     });
        // });

        describe('GET /assistants/{assistant_id}/schemas - Get Assistant Schemas', () => {
            it('should get assistant schemas', async () => {
                const schemas = await client.assistants.getSchemas('test-simple');
                expect(schemas).toBeDefined();
                expect(schemas).toHaveProperty('graph_id');
                expect(schemas).toHaveProperty('state_schema');
            });
        });

        describe('POST /assistants/{assistant_id}/versions - Get Assistant Versions', () => {
            it('should get all versions of an assistant', async () => {
                const versions = await client.assistants.getVersions('test-simple');
                expect(Array.isArray(versions)).toBe(true);
                expect(versions.length).toBeGreaterThan(0);
            });

            it('should get versions with limit', async () => {
                const versions = await client.assistants.getVersions('test-simple', {
                    limit: 1,
                });
                expect(versions.length).toBeLessThanOrEqual(1);
            });

            it('should get versions with offset', async () => {
                const allVersions = await client.assistants.getVersions('test-simple');
                if (allVersions.length > 1) {
                    const versions = await client.assistants.getVersions('test-simple', {
                        offset: 1,
                    });
                    expect(versions.length).toBe(allVersions.length - 1);
                }
            });
        });

        describe('POST /assistants/{assistant_id}/latest - Set Latest Assistant Version', () => {
            it('should set latest version for assistant', async () => {
                // This test is a placeholder - the actual implementation
                // would need to support version management
                const assistant = await client.assistants.setLatest('test-simple', 1);
                expect(assistant).toHaveProperty('version', 1);
            });
        });

        // describe('POST /assistants - Create Assistant', () => {
        //     it('should create a new assistant', async () => {
        //         // This test is a placeholder - the actual implementation
        //         // would need to support creating assistants
        //         const assistant = await client.assistants.create({
        //             graphId: 'test-simple',
        //             name: 'Test Assistant',
        //             description: 'A test assistant',
        //         });
        //         expect(assistant).toHaveProperty('assistant_id');
        //         expect(assistant).toHaveProperty('graph_id', 'test-simple');
        //         expect(assistant).toHaveProperty('name', 'Test Assistant');
        //     });

        //     it('should create assistant with custom ID', async () => {
        //         // This test is a placeholder - the actual implementation
        //         // would need to support creating assistants
        //         const assistant = await client.assistants.create({
        //             assistantId: 'custom-assistant-id',
        //             graphId: 'test-simple',
        //         });
        //         expect(assistant).toHaveProperty('assistant_id', 'custom-assistant-id');
        //     });

        //     it('should create assistant with metadata', async () => {
        //         // This test is a placeholder - the actual implementation
        //         // would need to support creating assistants
        //         const assistant = await client.assistants.create({
        //             graphId: 'test-simple',
        //             metadata: { key: 'value' },
        //         });
        //         expect(assistant).toHaveProperty('metadata');
        //         expect(assistant.metadata).toHaveProperty('key', 'value');
        //     });

        //     it('should create assistant with config', async () => {
        //         // This test is a placeholder - the actual implementation
        //         // would need to support creating assistants
        //         const assistant = await client.assistants.create({
        //             graphId: 'test-simple',
        //             config: {
        //                 tags: ['test-tag'],
        //                 recursionLimit: 10,
        //             },
        //         });
        //         expect(assistant).toHaveProperty('config');
        //         expect(assistant.config.tags).toContain('test-tag');
        //         expect(assistant.config.recursionLimit).toBe(10);
        //     });

        //     it('should handle ifExists=raise on duplicate', async () => {
        //         // This test is a placeholder - the actual implementation
        //         // would need to support creating assistants
        //         await expect(
        //             client.assistants.create({
        //                 assistantId: 'test-simple',
        //                 graphId: 'test-simple',
        //                 ifExists: 'raise',
        //             }),
        //         ).rejects.toThrow();
        //     });

        //     it('should handle ifExists=do_nothing on duplicate', async () => {
        //         // This test is a placeholder - the actual implementation
        //         // would need to support creating assistants
        //         const assistant = await client.assistants.create({
        //             assistantId: 'test-simple',
        //             graphId: 'test-simple',
        //             ifExists: 'do_nothing',
        //         });
        //         expect(assistant).toHaveProperty('assistant_id', 'test-simple');
        //     });
        // });
    });
});
