const vscode = require('vscode');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai'); 
const slugify = require('slugify');


function activate(context) {
    console.log('Congratulations, your extension "figma-to-strapi" is now active!');

    let disposable = vscode.commands.registerCommand('strapi-gen.start', async function () {
        
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            vscode.window.showErrorMessage('Please open a folder (Strapi project root) before running this generator.');
            return;
        }
        const rootPath = workspaceFolders[0].uri.fsPath;

        const source = await vscode.window.showQuickPick(['Figma Design', 'HTML Code'], {
            placeHolder: 'Select the source for your API design',
            ignoreFocusOut: true
        });

        if (!source) return; 

        const config = vscode.workspace.getConfiguration('figmaToStrapi');
        /** @type {string | undefined} */
        const figmaToken = config.get('figmaToken');
        /** @type {string | undefined} */
        const googleApiKey = "AIzaSyCiSBHj4iW2kxbQDBGuQuWORXKUFzWZwCw"; 

        if (!googleApiKey) {
            vscode.window.showErrorMessage('Missing Google API Key. Please check settings.');
            return;
        }
        if (source === 'Figma Design' && !figmaToken) {
            vscode.window.showErrorMessage('Missing Figma Token. Please check settings.');
            return;
        }

        let designInput = null;
        let fileKey = null;

        if (source === 'Figma Design') {
            fileKey = await vscode.window.showInputBox({
                placeHolder: 'e.g., f82j19f821j9f821j',
                prompt: 'Enter your Figma File Key (found in the URL)',
                ignoreFocusOut: true
            });
            if (!fileKey) return;
        } else {
            designInput = await vscode.window.showInputBox({
                placeHolder: '<div class="product">...</div>',
                prompt: 'Paste your raw HTML code here to generate the schema',
                ignoreFocusOut: true
            });

            if (!designInput || designInput.trim().length === 0) {
                return;
            }
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Generating Strapi Backend from ${source}...`,
            cancellable: false
        }, async (progress, token) => {
            
            try {
                let schemaData;
                let itemCount = 0;

                if (source === 'Figma Design') {
                    //figma
                    progress.report({ increment: 10, message: "Fetching Figma design..." });
                    const document = await getFigmaDocument(fileKey, figmaToken);
                    
                    progress.report({ increment: 30, message: "Analyzing design structure..." });
                    const designTokens = extractDesignEntities(document);
                    itemCount = designTokens.length;

                    if (itemCount === 0) throw new Error("No top-level frames starting with '#' found.");

                    progress.report({ increment: 40, message: "Architecting schemas (Gemini)..." });
                    schemaData = await generateStrapiSchemas(googleApiKey, designTokens);

                } else {
                    //html or react
                    progress.report({ increment: 20, message: "Analyzing HTML structure..." });
                    
                    progress.report({ increment: 40, message: "Architecting schemas from HTML (Gemini)..." });
                    schemaData = await generateStrapiSchemasFromHtml(googleApiKey, designInput);
                    
                    itemCount = schemaData.schemas ? schemaData.schemas.length : 0;
                }

                //fs
                progress.report({ increment: 80, message: "Writing files to disk..." });
                await writeFilesToStrapi(schemaData, rootPath);

                progress.report({ increment: 100, message: "Done!" });
                vscode.window.showInformationMessage(`Successfully generated ${itemCount} Content Types! Run 'npm run develop' to apply.`);

            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Generation Failed: ${errorMessage}`);
                console.error(error);
            }
        });
    });

    context.subscriptions.push(disposable);
}

async function getFigmaDocument(fileKey, token) {
    try {
        const response = await axios.get(`https://api.figma.com/v1/files/${fileKey}`, {
            headers: { 'X-Figma-Token': token }
        });
        return response.data.document;
    } catch (error) {
        // @ts-ignore
        const statusText = error.response?.statusText || 'Unknown Error';
        // @ts-ignore
        const message = error.message || 'No message';
        throw new Error(`Figma API Error: ${statusText} - ${message}`);
    }
}

function extractDesignEntities(node, entities = []) {
    if (node.type === 'FRAME' || node.type === 'COMPONENT') {
        const isModel = node.name.startsWith('#') || node.name.includes('Page') || node.name.includes('Card');
        
        if (isModel) {
            const entity = {
                name: node.name.replace('#', '').trim(),
                type: 'Model',
                visualChildren: []
            };

            /** @param {any} childNode */
            function findFields(childNode) {
                if (childNode.type === 'TEXT') {
                    // @ts-ignore
                    entity.visualChildren.push({ type: 'text', content: childNode.name, value: childNode.characters });
                } else if (childNode.children) {
                    childNode.children.forEach(findFields);
                }
            }
            
            if (node.children) node.children.forEach(findFields);
            entities.push(entity);
        }
    }

    if (node.children) {
        node.children.forEach(child => extractDesignEntities(child, entities));
    }
    return entities;
}

async function generateStrapiSchemas(apiKey, designTokens) {
    const genAI = new GoogleGenerativeAI(apiKey);
    
    const model = genAI.getGenerativeModel({ 
        model: "gemini-2.0-flash",
        generationConfig: { responseMimeType: "application/json" }
    });

    const systemPrompt = `
      You are a Strapi v4 Schema Expert. Convert the provided Figma entities into JSON schemas.
      
      CRITICAL STRAPI v4 REQUIREMENTS:
      1. Every schema MUST contain an "info" object.
      2. The "info" object MUST contain "singularName", "pluralName", and "displayName".
      3. "singularName": lowercase, no spaces, dashes allowed.
      4. "pluralName": lowercase, plural, no spaces.
      5. "collectionName": lowercase, snake_case.
      6. "kind": "collectionType".
      
      Return ONLY a JSON object with a "schemas" key containing an array.
    `;

    const result = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: JSON.stringify(designTokens) }] }],
        systemInstruction: systemPrompt
    });

    const response = await result.response;
    const content = response.text();
    if (!content) throw new Error("AI returned empty response");
    return JSON.parse(content);
}

async function generateStrapiSchemasFromHtml(apiKey, htmlContent) {
    const genAI = new GoogleGenerativeAI(apiKey);
    
    const model = genAI.getGenerativeModel({ 
        model: "gemini-2.0-flash",
        generationConfig: { responseMimeType: "application/json" }
    });

    const systemPrompt = `
      You are a Strapi v4 Schema Expert. Analyze the provided HTML code or react component code to reverse-engineer the data model.
      
      Instructions:
      1. Identify distinct entities (e.g., a "Product Card" implies a "Product" model, a "Contact Form" implies a "ContactRequest" model).
      2. Extract fields from inputs, list items, and text elements.
      3. Infer field types (e.g., <input type="number"> -> decimal/integer, <img> -> media).
      
      CRITICAL STRAPI v4 REQUIREMENTS:
      1. Every schema MUST contain an "info" object with "singularName", "pluralName", and "displayName".
      2. "singularName": lowercase, no spaces (e.g. "blog-post").
      3. "pluralName": lowercase, plural (e.g. "blog-posts").
      4. "collectionName": lowercase, snake_case.
      5. "kind": "collectionType".
      output files in ts instead of js
      Return ONLY a JSON object with a "schemas" key containing an array.
      Format: { "schemas": [ { "modelName": "string", "schema": { ... } } ] }
    `;

    const result = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: `Here is the HTML code:\n${htmlContent}` }] }],
        systemInstruction: systemPrompt
    });

    const response = await result.response;
    const content = response.text();
    if (!content) throw new Error("AI returned empty response");
    return JSON.parse(content);
}

async function writeFilesToStrapi(generatedData, rootDir) {
    const apiDir = path.join(rootDir, 'src', 'api');
    
    const schemaList = generatedData.schemas || generatedData; 

    if (!Array.isArray(schemaList)) {
        throw new Error("Invalid schema format received from AI");
    }

    for (const item of schemaList) {
        if (!item.modelName || !item.schema) continue;

        let slug;
        if (item.schema.info && item.schema.info.singularName) {
            slug = item.schema.info.singularName;
        } else {
            slug = slugify(item.modelName, { lower: true, strict: true });
        }

        const modelDir = path.join(apiDir, slug, 'content-types', slug);
        
        if (!fs.existsSync(modelDir)){
            fs.mkdirSync(modelDir, { recursive: true });
        }

        const filePath = path.join(modelDir, 'schema.json');
        fs.writeFileSync(filePath, JSON.stringify(item.schema, null, 2));

        const controllerDir = path.join(apiDir, slug, 'controllers');
        if (!fs.existsSync(controllerDir)){
            fs.mkdirSync(controllerDir, { recursive: true });
            const controllerCode = `
'use strict';
/**
 * ${slug} controller
 */
const { createCoreController } = require('@strapi/strapi').factories;
module.exports = createCoreController('api::${slug}.${slug}');
            `;
            fs.writeFileSync(path.join(controllerDir, `${slug}.js`), controllerCode.trim());
        }
    }
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
}