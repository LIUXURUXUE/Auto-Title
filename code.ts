// This plugin will open a window to prompt the user to enter a number, and
// it will then create that many rectangles on the screen.

// This file holds the main code for plugins. Code in this file has access to
// the *figma document* via the figma global object.
// You can access browser APIs in the <script> tag inside "ui.html" which has a
// full browser environment (See https://www.figma.com/plugin-docs/how-plugins-run).

// This shows the HTML page in "ui.html".
figma.showUI(__html__);

// Calls to "parent.postMessage" from within the HTML page will trigger this
// callback. The callback will be passed the "pluginMessage" property of the
// posted message.
// 存储绑定信息的接口
interface PropertyBinding {
  componentKey: string;
  textProperty: string;
  instanceProperty: string;
  timestamp: number;
}

// 刷新结果接口
interface RefreshResult {
  instance: string;
  success: boolean;
  error?: string;
}

let propertyBindings: PropertyBinding[] = [];

// 存储绑定信息
async function saveBindings(): Promise<void> {
  await figma.clientStorage.setAsync('propertyBindings', propertyBindings);
}

// 加载绑定信息
async function loadBindings(): Promise<void> {
  const stored = await figma.clientStorage.getAsync('propertyBindings');
  propertyBindings = stored || [];
}

// 分析组件属性
function analyzeComponentProperties(component: ComponentNode): { textProperties: string[]; instanceProperties: string[] } {
  const textProperties: string[] = [];
  const instanceProperties: string[] = [];

  // 获取文本图层
  const textNodes = component.findAll(node => node.type === 'TEXT') as TextNode[];
  textNodes.forEach(textNode => {
    if (textNode.name) {
      textProperties.push(textNode.name);
    }
  });

  // 修复：使用更安全的方式处理组件属性定义
  if (component.componentPropertyDefinitions) {
    // 使用 Object.keys 替代 Object.entries 避免类型问题
    const propertyKeys = Object.keys(component.componentPropertyDefinitions);
    
    propertyKeys.forEach(key => {
      const definition = component.componentPropertyDefinitions[key];
      // 使用类型安全的比较方式
      if (definition && 'type' in definition && definition.type === 'INSTANCE_SWAP') {
        instanceProperties.push(key);
      }
    });
  }

  return { textProperties, instanceProperties };
}

// 查找主组件的所有实例 - 修复版本，支持动态页面
async function findAllInstances(mainComponent: ComponentNode): Promise<InstanceNode[]> {
  const instances: InstanceNode[] = [];
  
  // 遍历所有页面查找实例
  for (const page of figma.root.children) {
    if (page.type === 'PAGE') {
      // 同步查找所有实例节点
      const allInstances = page.findAll(node => node.type === 'INSTANCE') as InstanceNode[];
      
      // 异步检查每个实例的主组件
      for (const instance of allInstances) {
        try {
          // 使用异步方法获取主组件
          const instanceMainComponent = await instance.getMainComponentAsync();
          if (instanceMainComponent && instanceMainComponent.key === mainComponent.key) {
            instances.push(instance);
          }
        } catch (error) {
          // 如果获取主组件失败，记录错误但继续处理其他实例
          console.error('获取实例主组件失败:', error);
        }
      }
    }
  }
  
  return instances;
}

// 批量刷新所有实例
async function refreshAllInstances(mainComponent: ComponentNode): Promise<{ success: number; total: number; results: RefreshResult[] }> {
  const instances = await findAllInstances(mainComponent);
  const componentKey = mainComponent.key;
  
  // 获取该组件的所有绑定
  const bindings = propertyBindings.filter(b => b.componentKey === componentKey);
  
  if (bindings.length === 0) {
    figma.notify('该组件没有配置任何绑定', { timeout: 2000 });
    return { success: 0, total: instances.length, results: [] };
  }
  
  if (instances.length === 0) {
    figma.notify('未找到该组件的任何实例', { timeout: 2000 });
    return { success: 0, total: 0, results: [] };
  }
  
  let successCount = 0;
  const results: RefreshResult[] = [];
  
  // 批量处理实例
  for (const instance of instances) {
    try {
      await applyBindingToInstance(instance, bindings);
      successCount++;
      results.push({ 
        instance: instance.name || instance.id, 
        success: true 
      });
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      results.push({ 
        instance: instance.name || instance.id, 
        success: false, 
        error: errorMessage
      });
    }
  }
  
  figma.notify(`刷新完成: ${successCount}/${instances.length} 个实例更新成功`);
  return { success: successCount, total: instances.length, results };
}

// 辅助函数：安全地获取错误信息
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  } else if (typeof error === 'string') {
    return error;
  } else {
    return '未知错误';
  }
}

// 应用绑定到单个实例
async function applyBindingToInstance(instance: InstanceNode, bindings: PropertyBinding[]): Promise<void> {
  for (const binding of bindings) {
    const instanceProperty = instance.componentProperties[binding.instanceProperty];
    
    if (instanceProperty && instanceProperty.value && typeof instanceProperty.value === 'string') {
      try {
        const targetComponent = figma.getNodeById(instanceProperty.value) as ComponentNode;
        if (targetComponent) {
          // 查找文本节点
          const textNode = instance.findOne(node => 
            node.type === 'TEXT' && node.name === binding.textProperty
          ) as TextNode;
          
          if (textNode) {
            // 加载字体并设置文本
            await figma.loadFontAsync(textNode.fontName as FontName);
            textNode.characters = targetComponent.name;
          }
        }
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        throw new Error(`应用绑定失败: ${errorMessage}`);
      }
    }
  }
}

// 主逻辑
figma.showUI(__html__, { width: 400, height: 600 });

// 异步主函数
async function main() {
  // 加载存储的绑定信息
  await loadBindings();

  // 根据当前选择显示界面
  const selection = figma.currentPage.selection[0];

  if (selection && selection.type === 'COMPONENT') {
    // 组件模式：显示绑定管理和刷新界面
    const properties = analyzeComponentProperties(selection);
    const instances = await findAllInstances(selection);
    
    figma.ui.postMessage({
      type: 'show-component-dashboard',
      componentKey: selection.key,
      componentName: selection.name,
      instanceCount: instances.length,
      textProperties: properties.textProperties,
      instanceProperties: properties.instanceProperties,
      existingBindings: propertyBindings.filter(b => b.componentKey === selection.key)
    });
  } else {
    figma.ui.postMessage({
      type: 'show-error',
      message: '请选择一个组件'
    });
  }
}

// 执行主逻辑
main().catch(error => {
  console.error('插件运行错误:', error);
  figma.notify('插件运行错误: ' + error.message, { error: true });
});

// 处理来自UI的消息
figma.ui.onmessage = async (msg: any) => {
  switch (msg.type) {
    case 'create-binding':
      // 创建新的属性绑定
      const newBinding: PropertyBinding = {
        componentKey: msg.componentKey,
        textProperty: msg.textProperty,
        instanceProperty: msg.instanceProperty,
        timestamp: Date.now()
      };
      
      propertyBindings.push(newBinding);
      await saveBindings();
      
      figma.ui.postMessage({
        type: 'binding-created',
        binding: newBinding
      });
      break;

    case 'refresh-all':
      // 刷新所有实例
      const component = figma.getNodeById(msg.componentKey) as ComponentNode;
      if (component) {
        const result = await refreshAllInstances(component);
        figma.ui.postMessage({
          type: 'refresh-completed',
          success: result.success,
          total: result.total,
          results: result.results
        });
      }
      break;

    case 'delete-binding':
      // 删除绑定
      propertyBindings = propertyBindings.filter(binding =>
        !(binding.componentKey === msg.componentKey && 
          binding.textProperty === msg.textProperty)
      );
      await saveBindings();
      
      figma.ui.postMessage({
        type: 'binding-deleted',
        textProperty: msg.textProperty
      });
      break;

    case 'cancel':
      figma.closePlugin();
      break;
  }
};