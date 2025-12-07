export interface LangGraphServerContext {
    /** 这个对象将会混合到 config.configurable 对象中 */
    langgraph_context?: any;
    /** 基础路径前缀，用于支持子路由挂载 */
    basePath?: string;
}
