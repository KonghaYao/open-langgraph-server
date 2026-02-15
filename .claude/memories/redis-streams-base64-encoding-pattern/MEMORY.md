---
name: 'redis-streams-base64-encoding-pattern'
description: 'Redis Streams 实现消息队列时的类型限制解决方案；Redis xAdd 命令只接受 string 类型值，不支持 Buffer 或对象；通过 base64 编码存储二进制数据（Uint8Array），读取时解码；配合 List 存储原始 Buffer 数据以支持 getAll()；适用于需要在 Redis Streams 中存储复杂数据类型的场景'
tags: ['redis', 'streams', 'base64-encoding', 'lazy-initialization', 'queue']
category: 'architecture'
created: '2025-01-20'
last_updated: '2025-01-20'
priority: 'medium'
context_scope: 'project'
---

# ## 背景

## 背景

Redis Streams 的 `xAdd` 命令只接受 **string** 类型的字段值，不支持直接传入 Buffer 或对象类型。但消息队列需要存储二进制数据（序列化后的 EventMessage），导致类型错误：`"arguments[4]" must be of type "string | Buffer", got object`。

## 解决方案

使用 **base64 编码**在 Redis Streams 中存储二进制数据，同时使用 Redis List 存储原始 Buffer 以支持批量获取。

### 1. push 方法 - 双存储策略

````typescript
async push(item: EventMessage): Promise\</arg_value>
</tool_call>
<tool_call>extract-1
<arg_key>summary_of_chat</arg_key>
<arg_value>用户反馈 RedisStreamQueue 修改后出现类型错误："arguments[4] must be of type string | Buffer, got object"。通过分析发现 Redis Streams 的 xAdd 命令只接受字符串类型值。解决方案：1) push 方法中使用 base64 编码存储 Uint8Array；2) onDataReceive 方法中从 base64 解码回 Buffer；3) copyToQueue 方法中确保所有字段值转换为字符串；4) getAll 方法处理 Buffer 和字符串类型；5) 将静态 redis 客户端改为延迟初始化，添加 ensureConnected 方法按需连接。✓ 完成：修复了 Redis Streams 类型兼容性问题并实现延迟初始化；⏳ 待定：无；→ 建议：测试修复后的队列功能确保数据正确性</arg_value>
<arg_key>name</arg_key>
<arg_value>redis-streams-base64-encoding-pattern</arg_value>
<arg_key>description</arg_key>
<arg_value>Redis Streams 实现消息队列时的类型限制解决方案；Redis xAdd 命令只接受 string 类型值，不支持 Buffer 或对象；通过 base64 编码存储二进制数据（Uint8Array），读取时解码；配合 List 存储原始 Buffer 数据以支持 getAll()；适用于需要在 Redis Streams 中存储复杂数据类型的场景</arg_value>
<arg_key>tags</arg_key>
<arg_value>["redis", "streams", "base64-encoding", "lazy-initialization", "queue"]</arg_value>
<arg_key>category</arg_key>
<arg_value>architecture</arg_value>
<arg_key>created</arg_key>
<arg_value>2025-01-20</arg_value>
<arg_key>last_updated</arg_key>
<arg_value>2025-01-20</arg_value>
<arg_key>priority</arg_key>
<arg_value>medium</arg_value>
<arg_key>context_scope</arg_key>
<arg_value>project</arg_value>
<arg_key>content</arg_key>
<arg_value>## 背景

Redis Streams 的 `xAdd` 命令只接受 **string** 类型的字段值，不支持直接传入 Buffer 或对象类型。但消息队列需要存储二进制数据（序列化后的 EventMessage），导致类型错误：`"arguments[4]" must be of type "string | Buffer", got object`。

## 解决方案

使用 **base64 编码**在 Redis Streams 中存储二进制数据，同时使用 Redis List 存储原始 Buffer 以支持批量获取。

### 1. push 方法 - 双存储策略

```typescript
async push(item: EventMessage): Promise\</arg_value>
</tool_call>
````
