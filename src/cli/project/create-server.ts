import { spawnSync } from 'child_process';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import prompts from 'prompts';
import { generateReadme } from '../templates/readme.js';
import { execa } from 'execa';

export async function createServer(
  name?: string,
  options?: { http: boolean, httpPort: number, sse: boolean, ssePort: number, cors: boolean, install: boolean, example: boolean }
) {
  let projectName: string;

  if (!name) {
    const response = await prompts([
      {
        type: 'text',
        name: 'projectName',
        message: 'What is the name of your MCP server project?',
        validate: (value: string) =>
          /^[a-z0-9-]+$/.test(value)
            ? true
            : 'Project name can only contain lowercase letters, numbers, and hyphens',
      },
    ]);

    if (!response.projectName) {
      console.warn('Project creation cancelled');
      process.exit(1);
    }

    projectName = response.projectName as string;
  } else {
    projectName = name;
  }

  if (!projectName) throw new Error('Project name is required');

  // ask for http
  let http = options?.http;
  if (!http) {
    const response = await prompts([
      {
        type: 'confirm',
        name: 'http',
        message: 'Do you want to use HTTP for the transport?',
        initial: true,
      },
    ])

    http = response.http;
  }

  if (typeof http !== 'boolean') throw new Error('use HTTP Transport is required');
  
  // ask for http port
  let httpPort = options?.httpPort;
  if (http === true && !httpPort) {
    const response = await prompts([
      {
        type: 'number',
        name: 'httpPort',
        message: 'Who port for the HTTP transport?',          
        initial: 3001,
      },
    ])

    httpPort = response.httpPort;
  }

  // ask for sse
  let sse = options?.sse;
  if (!sse) {
    const response = await prompts([
      {
        type: 'confirm',
        name: 'sse',
        message: 'Do you want to use SSE for the transport?',
        initial: false,
      },
    ])

    sse = response.sse;
  }
  
  if (typeof sse !== 'boolean') throw new Error('use SSE Transport is required');
  
  // ask for sse port
  let ssePort = options?.ssePort;
  if (sse === true && !ssePort) {
    const response = await prompts([
      {
        type: 'number',
        name: 'ssePort',
        message: 'Who port for the SSE transport?',          
        initial: 3401,
      },
    ])

    ssePort = response.ssePort;
  }

  // ask for cors
  let cors = options?.cors;
  if ((http || sse) &&  !cors ) {
    const response = await prompts([
      {
        type: 'confirm',
        name: 'cors',
        message: 'Do you want to enable CORS?',
        initial: true,
      },
    ])

    cors = response.cors;
  }

  let install = options?.install;
  if (!install) {
    const response = await prompts([
      {
        type: 'confirm',
        name: 'install',
        message: 'Do you want to install the project?',
        initial: true,
      },
    ])

    install = response.install;
  }

  let example = options?.example;
  if (!example) {
    const response = await prompts([
      {
        type: 'confirm',
        name: 'example',
        message: 'Do you want to create an example tool?',
        initial: true,
      },
    ])

    example = response.example;
  }


  // Default install and example to true if not specified
  const shouldInstall = install;
  const shouldCreateExample = example;

  const projectDir = join(process.cwd(), projectName);
  const srcDir = join(projectDir, 'src');
  const toolsDir = join(srcDir, 'tools');

  try {
    console.info('Creating project structure...');
    await mkdir(projectDir);
    await mkdir(srcDir);
    await mkdir(toolsDir);

    const packageJson = {
      name: projectName,
      version: '0.0.1',
      description: `${projectName} MCP server`,
      type: 'module',
      bin: {
        [projectName]: './dist/index.js',
      },
      files: ['dist'],
      scripts: {
        'build': 'tsc && mcp-build',
        'watch': 'tsc --watch',
        'start:http': 'node dist/index.js --transport http',
        'start:sse': 'node dist/index.js --transport sse',
        'start': 'node dist/index.js',
        'dev:http': 'tsc --watch && mcp-build && node dist/index.js',
        'dev:sse': 'tsc --watch && mcp-build && node dist/index.js',
        'dev': 'tsc --watch && mcp-build && node dist/index.js'
      },
      dependencies: {
        'mcp-setup': 'latest',
      },
      devDependencies: {
        '@types/node': '^20.11.24',
        typescript: '^5.3.3',
      },
      engines: {
        node: '>=18.19.0',
      },
    };

    const tsconfig = {
      compilerOptions: {
        target: 'ESNext',
        module: 'ESNext',
        moduleResolution: 'node',
        outDir: './dist',
        rootDir: './src',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
      },
      include: ['src/**/*'],
      exclude: ['node_modules'],
    };

    const gitignore = `node_modules
dist
.env
logs
.DS_Store
.idea
.vscode
`;
    let indexTs = '';
    let transportConfig = '';
    if (sse || http) {
      transportConfig = `
  transport: {`;

      if (http) {
        const port = httpPort || 3001;

        transportConfig += `
    http: {
      options: {
        port: ${port}`;

          if (cors) {
            transportConfig += `,
        cors: {
          allowOrigin: "*"
        }`;
          }
        transportConfig += `
      }
    }`;
      
      }
      
      if (sse) {
        const port = ssePort || 3401;
        transportConfig += `,
    sse: {
      options: {
        port: ${port}`;

          if (cors) {
            transportConfig += `,
        cors: {
          allowOrigin: "*"
        }`;
          }
        transportConfig += `
      }
    }`;
      }
      transportConfig += `
  }`;
    }

    if (transportConfig) {

      indexTs = `import { MCPServer } from "mcp-setup";

const server = new MCPServer({${transportConfig}
});

server.start();`;
    } else {
      indexTs = `import { MCPServer } from "mcp-setup";

const server = new MCPServer();

server.start();`;
    }

    const exampleToolTs = `import { MCPTool } from "mcp-setup";
import { z } from "zod";

interface ExampleInput {
  message: string;
  optionalString?: string;
  optionalNumber?: number;
  optionalBoolean?: boolean;
}

class ExampleTool extends MCPTool<ExampleInput> {
  name = "example_tool";
  description = "An example tool that processes messages";

  schema = {
    message: {
      type: 'string',
      description: "Message to process",
      required: true,
    },
    optionalString: {
      type: 'string',
      description: "An optional field"
    },
    optionalNumber: {
      type: 'number',
      description: "An optional number field"
    },
    optionalBoolean: {
      type: 'boolean',
      description: "An optional boolean field"
    }
  };

  async execute(input: ExampleInput) {

    return \`Processed: \${input.message} [string: \${input.optionalString || "-"}] [number: \${input.optionalNumber || "-"}] [boolean: \${input.optionalBoolean || "-"}] \`;
  }
}

export default ExampleTool;`;

    const filesToWrite = [
      writeFile(join(projectDir, 'package.json'), JSON.stringify(packageJson, null, 2)),
      writeFile(join(projectDir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2)),
      writeFile(join(projectDir, 'README.md'), generateReadme(projectName)),
      writeFile(join(srcDir, 'index.ts'), indexTs),
      writeFile(join(projectDir, '.gitignore'), gitignore),
    ];

    if (shouldCreateExample) {
      filesToWrite.push(writeFile(join(toolsDir, 'ExampleTool.ts'), exampleToolTs));
    }

    console.info('Creating project files...');
    await Promise.all(filesToWrite);

    process.chdir(projectDir);

    console.info('Initializing git repository...');
    const gitInit = spawnSync('git', ['init'], {
      stdio: 'inherit',
      shell: true,
    });

    if (gitInit.status !== 0) {
      throw new Error('Failed to initialize git repository');
    }

    if (shouldInstall) {
      console.info('Installing dependencies...');
      const npmInstall = spawnSync('npm', ['install'], {
        stdio: 'inherit',
        shell: true,
      });

      if (npmInstall.status !== 0) {
        throw new Error('Failed to install dependencies');
      }

      console.info('Building project...');
      const tscBuild = await execa('npx', ['tsc'], {
        cwd: projectDir,
        stdio: 'inherit',
      });

      if (tscBuild.exitCode !== 0) {
        throw new Error('Failed to build TypeScript');
      }

      const mcpBuild = await execa('npx', ['mcp-build'], {
        cwd: projectDir,
        stdio: 'inherit',
        env: {
          ...process.env,
          MCP_SKIP_VALIDATION: 'true',
        },
      });

      if (mcpBuild.exitCode !== 0) {
        throw new Error('Failed to run mcp-build');
      }

      console.info(`
Project ${projectName} created and built successfully!

You can now:
1. cd ${projectName}
2. Add more tools using:
   mcp-server add tool <n>
    `);
    } else {
      console.info(`
Project ${projectName} created successfully (without dependencies)!

You can now:
1. cd ${projectName}
2. Run 'npm install' to install dependencies
3. Run 'npm run build' to build the project
4. Add more tools using:
   mcp-server add tool <n>
    `);
    }
  } catch (error) {
    console.error('Error creating project:', error);
    process.exit(1);
  }
}
